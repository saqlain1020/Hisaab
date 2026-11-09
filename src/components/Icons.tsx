type P = { size?: number }
const svg = (d: React.ReactNode, size = 24) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
)

export const BackIcon = ({ size }: P) => svg(<path d="M15 18l-6-6 6-6" />, size)
export const PlusIcon = ({ size }: P) => svg(<path d="M12 5v14M5 12h14" />, size)
export const UsersIcon = ({ size }: P) =>
  svg(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
      <path d="M16 4.6a3.5 3.5 0 010 6.8M18.5 14.8c1.7.8 2.7 2.6 3 5.2" />
    </>,
    size,
  )
export const ShareIcon = ({ size }: P) =>
  svg(
    <>
      <path d="M12 3v12M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
    </>,
    size,
  )
export const MoreIcon = ({ size }: P) =>
  svg(
    <>
      <circle cx="12" cy="5" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" />
    </>,
    size,
  )
export const CheckIcon = ({ size }: P) => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, size)
export const CloudIcon = ({ size }: P) =>
  svg(<path d="M7 18a4.5 4.5 0 01-.6-9A6 6 0 0118 9.5 4.3 4.3 0 0117.5 18H7z" />, size)
export const AlertIcon = ({ size }: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>,
    size,
  )
export const UploadIcon = ({ size }: P) =>
  svg(
    <>
      <path d="M7 18a4.5 4.5 0 01-.6-9A6 6 0 0118 9.5 4.3 4.3 0 0117.5 18H7z" />
      <path d="M12 16v-5M9.5 13.5L12 11l2.5 2.5" />
    </>,
    size,
  )
export const LogoutIcon = ({ size }: P) =>
  svg(
    <>
      <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </>,
    size,
  )
