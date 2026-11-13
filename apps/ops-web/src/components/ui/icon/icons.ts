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
  Ellipsis,
  Eye,
  EyeOff,
  Flag,
  Funnel,
  Gavel,
  Handshake,
  Info,
  LaptopMinimalCheck,
  ListChecks,
  LogOut,
  Menu,
  MessageSquareText,
  Monitor,
  MonitorSmartphone,
  Moon,
  Package,
  PackagePlus,
  Plus,
  Scale,
  Search,
  Store,
  Sun,
  TriangleAlert,
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
  info: Info,
  filter: Funnel,

  // Navigation and the shell.
  'my-work': ListChecks,
  'pickup-requests': Package,
  'book-pickup': PackagePlus,
  'exception-approvals': Gavel,
  manifests: ClipboardList,
  'build-manifest': ClipboardPlus,
  // The work of the door and the failure (S1.30): a pickup that failed, a handshake that needs the office, a count that fell short and a count a vendor disputes.
  'failed-pickups': TriangleAlert,
  handshakes: Handshake,
  'short-counts': Scale,
  'collection-disputes': Flag,
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
  search: Search,
  plus: Plus,
  // The chevron of a button that opens a menu below it (the hub switcher's): a single chevron down, named for what it says (task R5.2, M16).
  'opens-menu': ChevronDown,
  'theme-light': Sun,
  'theme-dark': Moon,
  'theme-system': Monitor,

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
  // The kit (redesign step R5): the overflow menu of a record's acts. (The "+" of adding a filter is `plus`, the shell's.)
  'more-actions': Ellipsis,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** The names, in the order they are listed above, for a test or a showcase that shows every icon there is. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
