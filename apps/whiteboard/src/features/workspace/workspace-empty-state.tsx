import { Plus, Sparkles } from 'lucide-react'
import { Button } from '../../components/ui/button'

interface WorkspaceEmptyStateProps {
  isProjectPage?: boolean
  projectName?: string
  onCreateBoard: (suggestedName?: string) => void
}

export function WorkspaceEmptyState({ isProjectPage, projectName, onCreateBoard }: WorkspaceEmptyStateProps) {
  return (
    <section className="workspace-empty-hero" aria-label="No boards yet">
      <div className="empty-hero-graphic" aria-hidden="true">
        <svg viewBox="0 0 280 180" className="empty-hero-svg" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="hero-ambient-glow" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </radialGradient>
            <pattern id="empty-dot-grid" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1" fill="var(--empty-grid-dot)" />
            </pattern>
            <filter id="soft-shadow" x="-10%" y="-10%" width="120%" height="130%">
              <feDropShadow dx="0" dy="8" stdDeviation="12" floodOpacity="0.18" />
            </filter>
            <filter id="note-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="1" dy="3" stdDeviation="4" floodOpacity="0.22" />
            </filter>
          </defs>

          {/* Ambient Glow */}
          <circle cx="140" cy="88" r="82" fill="url(#hero-ambient-glow)" />

          {/* Background Card (Tilted Canvas) */}
          <rect
            x="44"
            y="26"
            width="192"
            height="124"
            rx="16"
            className="empty-canvas-back"
            transform="rotate(-3 140 88)"
          />

          {/* Foreground Main Canvas Card */}
          <g filter="url(#soft-shadow)">
            <rect x="44" y="22" width="192" height="124" rx="16" className="empty-canvas-front" />
            {/* Grid Pattern */}
            <rect x="45" y="23" width="190" height="122" rx="15" fill="url(#empty-dot-grid)" />
          </g>

          {/* Whiteboard Elements */}
          {/* Step 1: Flowchart Box */}
          <rect x="64" y="52" width="46" height="32" rx="6" className="empty-sketch-box" />
          <line
            x1="74"
            y1="64"
            x2="100"
            y2="64"
            className="empty-sketch-line"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <line
            x1="74"
            y1="72"
            x2="92"
            y2="72"
            className="empty-sketch-subline"
            strokeWidth="1.5"
            strokeLinecap="round"
          />

          {/* Connective Arrow */}
          <path
            d="M110 68 C124 68, 122 92, 136 92"
            fill="none"
            className="empty-sketch-arrow"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="3 3"
          />
          <polygon points="136,88 143,92 136,96" className="empty-sketch-arrowhead" />

          {/* Step 2: Target Node / Circle */}
          <circle cx="160" cy="92" r="16" className="empty-sketch-circle" />
          <polyline
            points="154,92 159,96 167,87"
            fill="none"
            className="empty-sketch-checkmark"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Sticky Note */}
          <g transform="rotate(4 190 60)" filter="url(#note-shadow)">
            <rect x="166" y="38" width="44" height="44" rx="5" fill="#fbbf24" />
            {/* Sticky tape / pin */}
            <rect x="179" y="35" width="18" height="6" rx="2" fill="rgba(255, 255, 255, 0.65)" />
            <line x1="174" y1="49" x2="202" y2="49" stroke="#b45309" strokeWidth="2" strokeLinecap="round" />
            <line x1="174" y1="57" x2="198" y2="57" stroke="#b45309" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="174" y1="65" x2="190" y2="65" stroke="#b45309" strokeWidth="1.5" strokeLinecap="round" />
          </g>

          {/* Marker / Stylus */}
          <g transform="translate(62, 86) rotate(-26)">
            <rect x="0" y="0" width="9" height="28" rx="2" fill="var(--accent)" />
            <polygon points="0,28 9,28 4.5,37" fill="#f59e0b" />
            <circle cx="4.5" cy="37" r="1.2" fill="#1f2028" />
            <rect x="0" y="5" width="9" height="3" fill="#ffffff" opacity="0.6" />
          </g>

          {/* Floating Sparkles */}
          <path d="M214 26 Q214 33 221 33 Q214 33 214 40 Q214 33 207 33 Q214 33 214 26 Z" fill="#fbbf24" />
          <path
            d="M46 112 Q46 117 51 117 Q46 117 46 122 Q46 117 41 117 Q46 117 46 112 Z"
            fill="var(--accent)"
            opacity="0.85"
          />
        </svg>
      </div>

      <div className="empty-hero-content">
        <h2 className="empty-hero-title">
          {isProjectPage ? `No boards in ${projectName || 'this project'} yet` : 'Your canvas is waiting'}
        </h2>
        <p className="empty-hero-description">
          {isProjectPage
            ? 'Create a board to start planning, sketching, and collaborating within this project.'
            : 'Start with a blank canvas to sketch diagrams, map user journeys, take visual notes, or collaborate in real time.'}
        </p>

        <div className="empty-hero-actions">
          <Button size="default" className="empty-hero-create-btn" onClick={() => onCreateBoard()}>
            <Plus size={16} />
            {isProjectPage ? 'Create board in project' : 'Create your first board'}
          </Button>
        </div>

        {!isProjectPage && (
          <div className="empty-hero-templates">
            <span className="empty-hero-templates-title">Quick ideas:</span>
            <div className="empty-hero-templates-list">
              <button
                type="button"
                className="empty-template-chip"
                onClick={() => onCreateBoard('Architecture Diagram')}
              >
                <Sparkles size={12} className="empty-template-chip-icon" />
                Architecture Diagram
              </button>
              <button type="button" className="empty-template-chip" onClick={() => onCreateBoard('Product Wireframes')}>
                <Sparkles size={12} className="empty-template-chip-icon" />
                Product Wireframes
              </button>
              <button type="button" className="empty-template-chip" onClick={() => onCreateBoard('Brainstorm & Notes')}>
                <Sparkles size={12} className="empty-template-chip-icon" />
                Brainstorm & Notes
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
