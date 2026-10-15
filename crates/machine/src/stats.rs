use offdesk_protocol::{DiskInfo, ResourceStats};
#[cfg(not(target_os = "macos"))]
use sysinfo::Disks;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

pub const MAX_SILENT_STATS_INTERVALS: u8 = 6;

pub struct StatsCollector {
    system: System,
    #[cfg(not(target_os = "macos"))]
    disks: Disks,
}

impl StatsCollector {
    pub fn new() -> Self {
        let system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        Self {
            system,
            #[cfg(not(target_os = "macos"))]
            disks: Disks::new_with_refreshed_list(),
        }
    }

    pub fn collect(&mut self) -> ResourceStats {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();

        let cpu_percent = self.system.global_cpu_usage();
        let memory_total = self.system.total_memory();
        let memory_used = self.system.used_memory();

        ResourceStats {
            cpu_percent,
            memory_total,
            memory_used,
            disks: self.collect_disks(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn collect_disks(&mut self) -> Vec<DiskInfo> {
        self.disks.refresh(true);
        self.disks
            .iter()
            .filter(|d| is_reported_mount(&d.mount_point().to_string_lossy()))
            .map(|d| DiskInfo {
                mount_point: d.mount_point().to_string_lossy().to_string(),
                total_bytes: d.total_space(),
                used_bytes: d.total_space() - d.available_space(),
            })
            .collect()
    }

    #[cfg(target_os = "macos")]
    fn collect_disks(&mut self) -> Vec<DiskInfo> {
        macos::mounted_disks()
    }
}

fn is_reported_mount(mount_point: &str) -> bool {
    mount_point == "/"
        || mount_point.starts_with("/home")
        || mount_point.starts_with("/mnt")
        || mount_point.starts_with("/Volumes")
        || mount_point.starts_with("/data")
}

/// sysinfo's macOS disk refresh asks CoreFoundation for
/// `AvailableCapacityForImportantUsage` on every mounted volume, an XPC round
/// trip to the CacheDelete daemon (`deleted`) that also writes ~20 log lines
/// per volume. At the 5s stats cadence that kept `deleted` busy and flooded
/// the unified log, so read the mount table and `statfs` the reported mounts
/// directly. Available space here excludes purgeable space, so usage reads a
/// little higher than Finder's figure.
#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString};
    use std::mem::{size_of, MaybeUninit};
    use std::ptr;

    use offdesk_protocol::DiskInfo;

    use super::is_reported_mount;

    pub fn mounted_disks() -> Vec<DiskInfo> {
        mount_points()
            .into_iter()
            .filter(|mount_point| is_reported_mount(mount_point))
            .filter_map(|mount_point| {
                let (total_bytes, available_bytes) = capacity(&mount_point)?;
                Some(DiskInfo {
                    mount_point,
                    total_bytes,
                    used_bytes: total_bytes.saturating_sub(available_bytes),
                })
            })
            .collect()
    }

    /// Browsable mount points from the kernel's mount table. `MNT_NOWAIT`
    /// skips refreshing each file system's counters, which `capacity` does.
    fn mount_points() -> Vec<String> {
        // SAFETY: getfsstat writes at most `bufsize` bytes of statfs records
        // and returns how many it wrote; we only read those.
        unsafe {
            let count = libc::getfsstat(ptr::null_mut(), 0, libc::MNT_NOWAIT);
            if count < 1 {
                return Vec::new();
            }
            let mut mounts: Vec<libc::statfs> = Vec::with_capacity(count as usize);
            let bufsize = (mounts.capacity() * size_of::<libc::statfs>()) as libc::c_int;
            let count = libc::getfsstat(mounts.as_mut_ptr(), bufsize, libc::MNT_NOWAIT);
            if count < 1 {
                return Vec::new();
            }
            mounts.set_len(count as usize);
            mounts
                .iter()
                // Hidden APFS volumes (VM, Preboot, the Data volume behind
                // `/`), matching sysinfo's browsable filter.
                .filter(|m| m.f_flags & libc::MNT_DONTBROWSE as u32 == 0)
                .map(|m| {
                    CStr::from_ptr(m.f_mntonname.as_ptr())
                        .to_string_lossy()
                        .into_owned()
                })
                .collect()
        }
    }

    /// Total and available bytes for the file system mounted at `mount_point`.
    fn capacity(mount_point: &str) -> Option<(u64, u64)> {
        let path = CString::new(mount_point).ok()?;
        let mut stat = MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: `path` is NUL-terminated and statfs fills `stat` on success.
        let stat = unsafe {
            if libc::statfs(path.as_ptr(), stat.as_mut_ptr()) != 0 {
                return None;
            }
            stat.assume_init()
        };
        let block_size = u64::from(stat.f_bsize);
        Some((stat.f_blocks * block_size, stat.f_bavail * block_size))
    }
}

pub fn should_emit_stats(
    previous: Option<&ResourceStats>,
    next: &ResourceStats,
    silent_intervals: u8,
) -> bool {
    let Some(previous) = previous else {
        return true;
    };

    if silent_intervals >= MAX_SILENT_STATS_INTERVALS {
        return true;
    }

    stats_changed_enough(previous, next)
}

fn stats_changed_enough(previous: &ResourceStats, next: &ResourceStats) -> bool {
    if (previous.cpu_percent - next.cpu_percent).abs() >= 1.0 {
        return true;
    }

    if previous.memory_total != next.memory_total {
        return true;
    }

    if previous.memory_used.abs_diff(next.memory_used) >= 64 * 1024 * 1024 {
        return true;
    }

    if previous.disks.len() != next.disks.len() {
        return true;
    }

    previous
        .disks
        .iter()
        .zip(next.disks.iter())
        .any(|(left, right)| {
            left.mount_point != right.mount_point
                || left.total_bytes != right.total_bytes
                || left.used_bytes.abs_diff(right.used_bytes) >= 128 * 1024 * 1024
        })
}

#[cfg(test)]
mod tests {
    use super::{should_emit_stats, StatsCollector, MAX_SILENT_STATS_INTERVALS};
    use offdesk_protocol::{DiskInfo, ResourceStats};

    fn stats(cpu_percent: f32, memory_used: u64, disk_used: u64) -> ResourceStats {
        ResourceStats {
            cpu_percent,
            memory_total: 1024 * 1024 * 1024,
            memory_used,
            disks: vec![DiskInfo {
                mount_point: "/".to_string(),
                total_bytes: 2 * 1024 * 1024 * 1024,
                used_bytes: disk_used,
            }],
        }
    }

    #[test]
    fn first_stats_sample_is_always_emitted() {
        assert!(should_emit_stats(None, &stats(10.0, 512, 1024), 0));
    }

    #[test]
    fn small_changes_are_suppressed_before_keepalive_interval() {
        assert!(!should_emit_stats(
            Some(&stats(10.0, 512, 1024)),
            &stats(10.4, 512 + 1024, 1024 + 1024),
            2,
        ));
    }

    #[test]
    fn keepalive_interval_forces_a_stats_emit() {
        assert!(should_emit_stats(
            Some(&stats(10.0, 512, 1024)),
            &stats(10.1, 512 + 1024, 1024 + 1024),
            MAX_SILENT_STATS_INTERVALS,
        ));
    }

    #[test]
    fn significant_resource_changes_are_emitted_immediately() {
        assert!(should_emit_stats(
            Some(&stats(10.0, 512, 1024)),
            &stats(12.0, 512, 1024),
            0,
        ));
        assert!(should_emit_stats(
            Some(&stats(10.0, 512, 1024)),
            &stats(10.0, 512 + 64 * 1024 * 1024, 1024),
            0,
        ));
        assert!(should_emit_stats(
            Some(&stats(10.0, 512, 1024)),
            &stats(10.0, 512, 1024 + 128 * 1024 * 1024),
            0,
        ));
    }

    #[test]
    fn collect_reports_the_root_disk() {
        let stats = StatsCollector::new().collect();
        let root = stats
            .disks
            .iter()
            .find(|disk| disk.mount_point == "/")
            .expect("root disk is reported");
        assert!(root.total_bytes > 0);
        assert!(root.used_bytes > 0 && root.used_bytes < root.total_bytes);
    }
}
