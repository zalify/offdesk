//! Registrable domains ("eTLD+1") for the agent browser's login check.
//!
//! The CLI decides which 1Password items match a page, and the node refuses
//! to type a secret into a frame whose domain is not allowed. Both use these
//! functions so they cannot disagree.
//!
//! This is deliberately not the full Public Suffix List: a small static list
//! of the common multi-part public suffixes ([`MULTI_PART_SUFFIXES`]) covers
//! the sites people actually log in to. For a host under an unlisted
//! multi-part suffix (say `foo.example.co.xx`) the result is too broad
//! (`co.xx`), which is the wrong direction only for the suffix's other
//! tenants; add the suffix to the list. IP addresses and single-label hosts
//! (`localhost`) are their own registrable domain.

use std::net::IpAddr;

/// Public suffixes made of two labels. A host ending in one of these has the
/// suffix plus one more label as its registrable domain.
pub const MULTI_PART_SUFFIXES: &[&str] = &[
    // China
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "mil.cn",
    // Hong Kong, Taiwan, Macau
    "com.hk", "net.hk", "org.hk", "edu.hk", "gov.hk", "idv.hk", "com.tw", "net.tw", "org.tw",
    "edu.tw", "gov.tw", "idv.tw", "com.mo",
    // United Kingdom
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
    // Japan, Korea
    "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr",
    // Oceania
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "net.nz", "org.nz", "govt.nz",
    // Asia
    "com.sg", "edu.sg", "gov.sg", "com.my", "com.ph", "com.vn", "co.th", "co.id", "or.id", "co.in",
    "net.in", "org.in", "ac.in", "gov.in", "com.pk",
    // Americas
    "com.br", "net.br", "org.br", "gov.br", "com.mx", "com.ar", "com.co", "com.pe", "com.ve",
    // Africa, Middle East, Europe
    "co.za", "org.za", "com.ng", "com.eg", "com.tr", "com.sa", "co.il", "org.il", "com.ua",
    "com.pl", "com.ru",
];

/// The lower-cased host of a URL (`https://u:p@Login.Example.com:8443/x` ->
/// `login.example.com`), without port, userinfo or IPv6 brackets. `None` for
/// URLs without a host (`about:blank`, `data:`).
pub fn host_of_url(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// The registrable domain of a host name (see the module docs).
pub fn registrable_domain(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok() || !host.contains('.') {
        return host;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    let last_two = format!("{}.{}", labels[n - 2], labels[n - 1]);
    let keep = if n >= 3 && MULTI_PART_SUFFIXES.contains(&last_two.as_str()) {
        3
    } else {
        2
    };
    labels[n - keep..].join(".")
}

/// The registrable domain of a URL's host, `None` when it has no host.
pub fn registrable_domain_of_url(url: &str) -> Option<String> {
    host_of_url(url).map(|host| registrable_domain(&host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrable_domains() {
        for (host, want) in [
            ("aliyun.com", "aliyun.com"),
            ("account.aliyun.com", "aliyun.com"),
            ("passport.aliyun.com", "aliyun.com"),
            ("a.b.c.aliyun.com", "aliyun.com"),
            ("Passport.Aliyun.COM.", "aliyun.com"),
            ("foo.com.cn", "foo.com.cn"),
            ("www.foo.com.cn", "foo.com.cn"),
            ("sub.www.foo.com.cn", "foo.com.cn"),
            ("bbc.co.uk", "bbc.co.uk"),
            ("news.bbc.co.uk", "bbc.co.uk"),
            ("x.com.hk", "x.com.hk"),
            ("a.x.org.cn", "x.org.cn"),
            ("a.x.net.cn", "x.net.cn"),
            // The suffix itself, with nothing registered under it.
            ("com.cn", "com.cn"),
            ("localhost", "localhost"),
            ("127.0.0.1", "127.0.0.1"),
            ("::1", "::1"),
            ("2001:db8::1", "2001:db8::1"),
        ] {
            assert_eq!(registrable_domain(host), want, "{host}");
        }
    }

    #[test]
    fn hosts_of_urls() {
        for (url, want) in [
            ("https://passport.aliyun.com/mini_login.htm?x=1#y", Some("passport.aliyun.com")),
            ("http://LOCALHOST:8080/a", Some("localhost")),
            ("https://user:pw@Example.com:8443/", Some("example.com")),
            ("http://127.0.0.1:3000", Some("127.0.0.1")),
            ("http://[::1]:3000/x", Some("::1")),
            ("https://example.com?x=1", Some("example.com")),
            ("about:blank", None),
            ("data:text/html,hi", None),
            ("", None),
            ("https://", None),
        ] {
            assert_eq!(host_of_url(url).as_deref(), want, "{url}");
        }
        assert_eq!(
            registrable_domain_of_url("https://account.aliyun.com/login").as_deref(),
            Some("aliyun.com")
        );
        assert_eq!(registrable_domain_of_url("about:blank"), None);
    }
}
