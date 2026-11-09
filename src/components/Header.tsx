import { BackIcon } from './Icons'

export function Header(props: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  onBack?: () => void
  actions?: React.ReactNode
  below?: React.ReactNode
}) {
  return (
    <header className="app-header">
      <div className="header-row">
        {props.onBack && (
          <button className="icon-btn" onClick={props.onBack} aria-label="Back">
            <BackIcon />
          </button>
        )}
        <div className="header-title">
          <h1>{props.title}</h1>
          {props.subtitle && <div className="header-sub">{props.subtitle}</div>}
        </div>
        {props.actions && <div className="header-actions">{props.actions}</div>}
      </div>
      {props.below}
    </header>
  )
}
