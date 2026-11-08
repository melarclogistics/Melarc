import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bike,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  ClipboardPlus,
  Eye,
  EyeOff,
  Funnel,
  House,
  LaptopMinimalCheck,
  LogOut,
  Menu,
  MessageSquareText,
  MonitorSmartphone,
  Package,
  PackageCheck,
  PackagePlus,
  Store,
  User,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * The one family of icons of the Ops Portal (DESIGN_SYSTEM section 24): **Lucide**, chosen by the Product Owner on 25 October 2026
 * (https://github.com/lucide-icons/lucide, ISC licence, `lucide-react`, self-hosted in the bundle and never loaded from a CDN).
 *
 * **This is the only file that imports `lucide-react`** (`test/icon-registry.test.ts` fails on any other, and ESLint refuses it), so the
 * rest of the application names an icon by what it means, never by the library's name for its picture, and a change of family or of a
 * picture is one line here. An icon is added to this list when a screen needs it, with the meaning it stands for: there is no catalogue
 * of icons nobody uses, and the build ships only the ones named here.
 *
 * Names are by meaning. The same meaning has the same picture everywhere: `warning` is the one picture for a thing that went wrong
 * (alerts, field errors), `success` for a thing that worked.
 */
export const ICONS = {
  // Status: they supplement the words, never replace them (DESIGN_SYSTEM section 24).
  warning: CircleAlert,
  success: CircleCheck,
  filter: Funnel,

  // Navigation and the shell.
  overview: House,
  'pickup-requests': Package,
  'book-pickup': PackagePlus,
  'exception-approvals': PackageCheck,
  manifests: ClipboardList,
  'build-manifest': ClipboardPlus,
  messages: MessageSquareText,
  staff: Users,
  'add-staff': UserPlus,
  sessions: MonitorSmartphone,
  'trusted-browsers': LaptopMinimalCheck,
  vendors: Store,
  riders: Bike,
  account: User,
  menu: Menu,
  close: X,
  'collapse-menu': ChevronsLeft,
  'expand-menu': ChevronsRight,
  'sign-out': LogOut,

  // Controls.
  'show-password': Eye,
  'hide-password': EyeOff,
  'sort-ascending': ArrowUp,
  'sort-descending': ArrowDown,
  'sort-none': ArrowUpDown,
  'move-up': ChevronUp,
  'move-down': ChevronDown,
  previous: ChevronLeft,
  next: ChevronRight,
  calendar: Calendar,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** The names, in the order they are listed above, for a test or a showcase that shows every icon there is. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
