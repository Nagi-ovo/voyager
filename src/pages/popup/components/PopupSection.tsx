import React from 'react';

export interface PopupSectionReorderControls {
  isFirst: boolean;
  isLast: boolean;
  hasValueBadge: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  moveUpLabel: string;
  moveDownLabel: string;
}

export interface PopupSectionProps {
  visible: boolean;
  order: number;
  reorder?: PopupSectionReorderControls;
  children?: React.ReactNode;
}

/** A section's placement and controls; state and filtering belong to usePopupSections. */
export function PopupSection({ visible, order, reorder, children }: PopupSectionProps) {
  if (!visible) return null;
  return (
    <div style={{ order }} className="group/reorder relative">
      {reorder && <SectionReorderControls {...reorder} />}
      {children}
    </div>
  );
}

function SectionReorderControls({
  isFirst,
  isLast,
  hasValueBadge,
  onMoveUp,
  onMoveDown,
  moveUpLabel,
  moveDownLabel,
}: PopupSectionReorderControls) {
  const positionClass = hasValueBadge ? 'top-px' : 'top-1';
  const buttonClass = hasValueBadge
    ? 'text-muted-foreground hover:text-foreground hover:bg-secondary/80 flex h-4 w-4 items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed disabled:opacity-30'
    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/80 rounded-sm p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30';
  const iconSize = hasValueBadge ? 12 : 14;

  return (
    <div
      className={`absolute ${positionClass} right-1 z-10 flex gap-px rounded-md opacity-0 transition-opacity group-hover/reorder:opacity-100`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onMoveUp();
        }}
        disabled={isFirst}
        className={buttonClass}
        aria-label={moveUpLabel}
        title={moveUpLabel}
      >
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onMoveDown();
        }}
        disabled={isLast}
        className={buttonClass}
        aria-label={moveDownLabel}
        title={moveDownLabel}
      >
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </div>
  );
}
