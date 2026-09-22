import type { ReactElement, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'>;

/**
 * Decorative line icons drawn on a 24px grid. They inherit the text colour and
 * are hidden from assistive technology, so every icon needs a visible label or
 * an `aria-label` on the control that wraps it.
 */
const Icon = ({
  children,
  ...props
}: IconProps & { readonly children: ReactElement | ReactElement[] }) => (
  <svg
    aria-hidden="true"
    fill="none"
    focusable="false"
    height="16"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.6"
    viewBox="0 0 24 24"
    width="16"
    {...props}
  >
    {children}
  </svg>
);

export const ChevronUpIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <path d="m6 14 6-6 6 6" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <path d="m6 10 6 6 6-6" />
  </Icon>
);

export const TrashIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <path d="M4 7h16M10 4h4M9 7v12m6-12v12" />
    <path d="M6 7h12l-.8 12.1a1.5 1.5 0 0 1-1.5 1.4H8.3a1.5 1.5 0 0 1-1.5-1.4Z" />
  </Icon>
);

export const UploadIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
    <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
  </Icon>
);

export const CheckIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const AlertIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5.5m0 3h.01" />
  </Icon>
);

export const ImageIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <rect height="15" rx="2.5" width="18" x="3" y="4.5" />
    <circle cx="8.75" cy="10.25" r="1.5" />
    <path d="m3.5 16.5 4.7-4.2a2 2 0 0 1 2.7.05L15 16.5l1.8-1.6a2 2 0 0 1 2.7.06l1 .94" />
  </Icon>
);

export const UsersIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <circle cx="9.5" cy="8.5" r="3.5" />
    <path d="M3.5 19.5c0-3 2.7-5 6-5s6 2 6 5" />
    <path d="M16 5.6a3.5 3.5 0 0 1 0 6.8m.8 2.4c2.4.4 4.2 2.2 4.2 4.7" />
  </Icon>
);

export const SignOutIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <path d="M15 8V6a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 15 18v-2" />
    <path d="M11 12h9m0 0-3-3m3 3-3 3" />
  </Icon>
);

export const ShieldIcon = (props: IconProps): ReactElement => (
  <Icon {...props}>
    <path d="M12 3.5 5 6v6c0 4.2 2.9 7.4 7 8.5 4.1-1.1 7-4.3 7-8.5V6Z" />
    <path d="m9.2 12.2 2 2 3.6-3.9" />
  </Icon>
);
