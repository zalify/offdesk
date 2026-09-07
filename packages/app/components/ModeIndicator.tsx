import { colors, colorAlpha } from "@/lib/colors";

interface ModeIndicatorProps {
  isController: boolean;
  onRequestControl: () => void;
  onReleaseControl: () => void;
}

export function ModeIndicator({ isController, onRequestControl, onReleaseControl }: ModeIndicatorProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      background: isController ? colorAlpha.accentMedium15 : colors.surface,
      borderRadius: 6,
      border: '1px solid ' + (isController ? colors.accent : colors.border),
      fontSize: 12,
      userSelect: 'none' as const,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: isController ? colors.accent : colors.foregroundMuted,
        flexShrink: 0,
      }} />
      <span style={{ color: isController ? colors.accent : colors.foregroundSecondary }}>
        {isController ? 'Control' : 'Watch'}
      </span>
      <button
        onClick={isController ? onReleaseControl : onRequestControl}
        style={{
          background: 'none',
          border: '1px solid ' + (isController ? colors.foregroundMuted : colors.accent),
          borderRadius: 4,
          color: isController ? colors.foregroundSecondary : colors.accent,
          cursor: 'pointer',
          padding: '2px 8px',
          fontSize: 11,
        }}
      >
        {isController ? 'Release' : 'Take Control'}
      </button>
    </div>
  );
}
