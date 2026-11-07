import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/primitives/alert-dialog';
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from '@/components/primitives/avatar';
import { Badge } from '@/components/primitives/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/primitives/breadcrumb';
import { Button } from '@/components/primitives/button';
import { Calendar } from '@/components/primitives/calendar';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/primitives/card';
import { Checkbox } from '@/components/primitives/checkbox';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/primitives/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/primitives/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/primitives/dropdown-menu';
import { Input } from '@/components/primitives/input';
import { Label } from '@/components/primitives/label';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/primitives/popover';
import { ScrollArea } from '@/components/primitives/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/primitives/select';
import { Separator } from '@/components/primitives/separator';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/primitives/sheet';
import { Skeleton } from '@/components/primitives/skeleton';
import { toast, Toaster } from '@/components/primitives/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/primitives/tabs';
import { Textarea } from '@/components/primitives/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/primitives/tooltip';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/ui/icon/Icon';
import { DataTableDemo } from './DataTableDemo';
import './showcase.css';

/**
 * The development-only showcase of the shadcn/ui primitives (design/DESIGN_SYSTEM.md section 29; COMPONENT_PATTERNS section 27): every primitive
 * that is installed, on the tokens, in both themes, with the words a Melarc screen would use. It exists to look at the primitives and to give the
 * browser tests real ones to drive. Everything on it is synthetic and says so; it is not a second specification of any component, and the
 * components of components/ui that compose these primitives in step R5 are the ones a screen uses. Its route and its code are absent from the
 * production build, which test/build.test.ts proves.
 */

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="showcase-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

type ThemeChoice = 'system' | 'light' | 'dark';

/** A switch for this page only, held in memory and never stored: the portal's own theme control and its stored choice are the shell's (`platform/theme/theme-choice.ts`). */
function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const set = document.documentElement.getAttribute('data-theme');
    return set === 'light' || set === 'dark' ? set : 'system';
  });
  useEffect(() => {
    if (choice === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', choice);
  }, [choice]);

  return (
    <div role="group" aria-label="Theme of this page" className="showcase-row">
      {(['system', 'light', 'dark'] as const).map((value) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={choice === value ? 'default' : 'outline'}
          aria-pressed={choice === value}
          onClick={() => {
            setChoice(value);
          }}
        >
          {value === 'system' ? 'System' : value === 'light' ? 'Light' : 'Dark'}
        </Button>
      ))}
    </div>
  );
}

function ButtonsAndBadges() {
  return (
    <Section title="Buttons and badges">
      <div className="showcase-stack">
        <div className="showcase-row">
          <Button>Save changes</Button>
          <Button variant="brand">
            <Icon name="book-pickup" />
            New pickup request
          </Button>
          <Button variant="secondary">Export list</Button>
          <Button variant="outline">Filter</Button>
          <Button variant="ghost">Clear filters</Button>
          <Button variant="destructive">Cancel request</Button>
          <Button variant="link">View the audit trail</Button>
          <Button disabled>Dispatch manifest</Button>
        </div>
        <div className="showcase-row">
          <Button size="sm">Small, 36 px</Button>
          <Button>Default, 44 px</Button>
          <Button size="lg">Large, 56 px</Button>
          <Button size="icon" variant="outline" aria-label="Open the menu">
            <Icon name="menu" />
          </Button>
        </div>
        <div className="showcase-row">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="neutral">Draft</Badge>
          <Badge variant="info">Dispatched</Badge>
          <Badge variant="success">Delivered</Badge>
          <Badge variant="warning">Delayed</Badge>
          <Badge variant="danger">Failed</Badge>
          <Badge variant="destructive">Cancelled</Badge>
        </div>
      </div>
    </Section>
  );
}

function Fields() {
  const [accepted, setAccepted] = useState<boolean | 'indeterminate'>(false);
  return (
    <Section title="Fields">
      <div className="showcase-fields">
        <div className="showcase-field">
          <Label htmlFor="px-vendor">Vendor name</Label>
          <Input id="px-vendor" defaultValue="Demo Bakery" />
        </div>
        <div className="showcase-field">
          <Label htmlFor="px-reference">Vendor reference</Label>
          <Input id="px-reference" placeholder="For example, DEMO-0104" />
        </div>
        <div className="showcase-field">
          <Label htmlFor="px-phone">Contact number</Label>
          <Input
            id="px-phone"
            aria-invalid
            aria-describedby="px-phone-error"
            defaultValue="024 000"
          />
          <p id="px-phone-error" className="showcase-error">
            <Icon name="warning" size="sm" />
            Enter the whole number, with ten digits.
          </p>
        </div>
        <div className="showcase-field">
          <Label htmlFor="px-readonly">Request state</Label>
          <Input id="px-readonly" readOnly defaultValue="Confirmed by the hub" />
        </div>
        <div className="showcase-field">
          <Label htmlFor="px-disabled">Hub assigned by the office</Label>
          <Input id="px-disabled" disabled defaultValue="Accra Central" />
        </div>
        <div className="showcase-field">
          <Label htmlFor="px-note">Note for the rider</Label>
          <Textarea id="px-note" placeholder="Where to find the parcels, who to ask for" />
        </div>
        <div className="showcase-field">
          <Label htmlFor="px-hub">Hub</Label>
          <Select defaultValue="accra-central">
            <SelectTrigger id="px-hub">
              <SelectValue placeholder="Choose a hub" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Greater Accra</SelectLabel>
                <SelectItem value="accra-central">Accra Central</SelectItem>
                <SelectItem value="tema">Tema</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Ashanti</SelectLabel>
                <SelectItem value="kumasi">Kumasi</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="showcase-field">
          <Label htmlFor="px-hub-small">Hub, small</Label>
          <Select>
            <SelectTrigger id="px-hub-small" size="sm">
              <SelectValue placeholder="Choose a hub" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tema">Tema</SelectItem>
              <SelectItem value="kumasi">Kumasi</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="showcase-stack">
        <div className="showcase-check">
          <Checkbox id="px-accept" checked={accepted} onCheckedChange={setAccepted} />
          <Label htmlFor="px-accept">The vendor has packed everything for this pickup</Label>
        </div>
        <div className="showcase-check">
          <Checkbox id="px-some" checked="indeterminate" />
          <Label htmlFor="px-some">Some of the parcels are ready</Label>
        </div>
        <div className="showcase-check">
          <Checkbox id="px-off" disabled />
          <Label htmlFor="px-off">Not available for a cancelled request</Label>
        </div>
        <div className="showcase-check">
          <Checkbox id="px-off-on" disabled defaultChecked />
          <Label htmlFor="px-off-on">Recorded and locked</Label>
        </div>
      </div>
    </Section>
  );
}

function Cards() {
  return (
    <Section title="Cards, tabs and navigation">
      <div className="showcase-surfaces">
        <Card>
          <CardHeader>
            <CardTitle>Request DEMO-0104</CardTitle>
            <CardDescription>Demo Bakery, Accra Central</CardDescription>
            <CardAction>
              <Badge variant="info">Confirmed</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p>Pickup on Monday 9 November 2026, between 09:00 and 11:00. Two parcels.</p>
          </CardContent>
          <CardFooter>
            <Button size="sm" variant="outline">
              Open the request
            </Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Rider for the run</CardTitle>
            <CardDescription>Assigned on 5 November 2026</CardDescription>
          </CardHeader>
          <CardContent className="showcase-row">
            <Avatar>
              <AvatarFallback>AM</AvatarFallback>
            </Avatar>
            <span>Ama Mensah (demo)</span>
          </CardContent>
        </Card>
      </div>
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="locked" disabled>
            Audit (not allowed)
          </TabsTrigger>
        </TabsList>
        <TabsContent value="details">Who asked for the pickup, where, and for when.</TabsContent>
        <TabsContent value="history">
          Each change to the request, with who made it and when.
        </TabsContent>
        <TabsContent value="messages">The messages sent about this request.</TabsContent>
      </Tabs>
      <Tabs defaultValue="open" orientation="vertical">
        <TabsList variant="line">
          <TabsTrigger value="open">Open requests</TabsTrigger>
          <TabsTrigger value="closed">Closed requests</TabsTrigger>
        </TabsList>
        <TabsContent value="open">Requests that still need a rider or a hub.</TabsContent>
        <TabsContent value="closed">Requests that were delivered or cancelled.</TabsContent>
      </Tabs>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Pickup requests</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Accra Central</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>DEMO-0104</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="showcase-surface showcase-surface--default showcase-row">
        <AvatarGroup>
          <Avatar>
            <AvatarFallback>AM</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>KO</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>EA</AvatarFallback>
          </Avatar>
          <AvatarGroupCount>+3</AvatarGroupCount>
        </AvatarGroup>
        <Separator orientation="vertical" className="showcase-divider" />
        <span>Three riders are out, three are free.</span>
        <Separator orientation="vertical" className="showcase-divider" />
        <Avatar size="sm">
          <AvatarFallback>AM</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>KO</AvatarFallback>
        </Avatar>
        <Avatar size="lg">
          <AvatarFallback>EA</AvatarFallback>
        </Avatar>
        <span>Small, default and large.</span>
      </div>
      <Separator />
    </Section>
  );
}

function Overlays() {
  const [palette, setPalette] = useState(false);
  const paletteButton = useRef<HTMLButtonElement>(null);
  return (
    <Section title="Overlays">
      <div className="showcase-row">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Edit the pickup note</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit the pickup note</DialogTitle>
              <DialogDescription>
                The rider reads this note before the pickup. It is part of the request and is kept
                in its history.
              </DialogDescription>
            </DialogHeader>
            <div className="showcase-field">
              <Label htmlFor="px-dialog-note">Note</Label>
              <Textarea
                id="px-dialog-note"
                defaultValue="Ring the bell twice; the parcels are at the counter."
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Keep the old note</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button>Save the note</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Cancel the request</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel request DEMO-0104?</AlertDialogTitle>
              <AlertDialogDescription>
                The vendor is told by message. A rider who already holds the run keeps it until the
                hub decides. This cannot be undone from this screen.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep the request</AlertDialogCancel>
              <AlertDialogAction variant="destructive">Cancel the request</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary">Open the request panel</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Request DEMO-0104</SheetTitle>
              <SheetDescription>Demo Bakery, Accra Central. Confirmed.</SheetDescription>
            </SheetHeader>
            <div className="showcase-stack showcase-panel">
              <p>Pickup on Monday 9 November 2026, between 09:00 and 11:00.</p>
              <p>Two parcels, 3.5 kg in all. Delivery to Tema.</p>
            </div>
            <SheetFooter>
              <SheetClose asChild>
                <Button variant="outline">Close the panel</Button>
              </SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Row actions</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Request DEMO-0104</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem>
                Open the request
                <DropdownMenuShortcut>Enter</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>Copy the reference</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked>Show cancelled requests</DropdownMenuCheckboxItem>
            <DropdownMenuRadioGroup value="date">
              <DropdownMenuRadioItem value="date">Sort by pickup date</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="vendor">Sort by vendor</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to another hub</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Tema</DropdownMenuItem>
                <DropdownMenuItem>Kumasi</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem variant="destructive">Cancel the request</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">
              <Icon name="filter" />
              Filters
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start">
            <PopoverHeader>
              <PopoverTitle>Narrow the list</PopoverTitle>
              <PopoverDescription>
                Only requests that match every choice are shown.
              </PopoverDescription>
            </PopoverHeader>
            <div className="showcase-field">
              <Label htmlFor="px-popover-vendor">Vendor</Label>
              <Input id="px-popover-vendor" placeholder="Part of the vendor name" />
            </div>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="outline" aria-label="Next pickup day">
              <Icon name="next" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Next pickup day</TooltipContent>
        </Tooltip>

        <Button
          variant="outline"
          onClick={() => {
            toast.success('Manifest MF-0101 dispatched', {
              description: 'The rider has the run. The hub is told when the first stop is reached.',
            });
          }}
        >
          Show a confirmation
        </Button>

        <Button
          ref={paletteButton}
          variant="outline"
          onClick={() => {
            setPalette(true);
          }}
        >
          Go to…
        </Button>
        <CommandDialog
          open={palette}
          onOpenChange={setPalette}
          title="Go to"
          description="Type to find a screen or a request."
          onCloseAutoFocus={(event) => {
            // The palette was opened by a button and not by a trigger of the dialog, so focus is given back here.
            event.preventDefault();
            paletteButton.current?.focus();
          }}
        >
          <CommandInput placeholder="Find a screen or a request" />
          <CommandList>
            <CommandEmpty>Nothing matches. Check the spelling, or try a shorter word.</CommandEmpty>
            <CommandGroup heading="Screens">
              <CommandItem>
                Pickup requests
                <CommandShortcut>G P</CommandShortcut>
              </CommandItem>
              <CommandItem>Manifests</CommandItem>
              <CommandItem>Riders</CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Requests">
              <CommandItem>DEMO-0104, Demo Bakery</CommandItem>
              <CommandItem>DEMO-0101, Demo Pharmacy</CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      </div>
      <div className="showcase-surface">
        <h3>A command list in the page</h3>
        <Command className="showcase-command" label="Find a screen">
          <CommandInput placeholder="Find a screen" />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup heading="Screens">
              <CommandItem>Pickup requests</CommandItem>
              <CommandItem>Manifests</CommandItem>
              <CommandItem>Message log</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </Section>
  );
}

function Dates() {
  const [day, setDay] = useState<Date | undefined>(new Date(2026, 10, 9));
  const [run, setRun] = useState<{ from: Date | undefined; to?: Date | undefined } | undefined>({
    from: new Date(2026, 10, 9),
    to: new Date(2026, 10, 13),
  });
  return (
    <Section title="Calendars">
      <div className="showcase-row showcase-top">
        <Calendar
          mode="single"
          selected={day}
          onSelect={setDay}
          defaultMonth={new Date(2026, 10, 1)}
        />
        <Calendar
          mode="range"
          selected={run}
          onSelect={setRun}
          defaultMonth={new Date(2026, 10, 1)}
        />
      </div>
    </Section>
  );
}

function Loading() {
  return (
    <Section title="Loading and scrolling">
      <div className="showcase-surfaces">
        <div className="showcase-stack" aria-busy="true">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
        <ScrollArea className="showcase-scroll" type="always">
          <ul className="showcase-scroll__list">
            {[
              'Tema',
              'Kumasi',
              'Takoradi',
              'Tamale',
              'Cape Coast',
              'Ho',
              'Koforidua',
              'Sunyani',
            ].map((hub) => (
              <li key={hub}>{hub} hub</li>
            ))}
          </ul>
        </ScrollArea>
      </div>
    </Section>
  );
}

/** The route's page. The primitives showcase sits inside the neutral frame like the component showcase. */
export function PrimitivesShowcasePage() {
  return (
    <TooltipProvider>
      <title>Primitives showcase · Melarc Ops Portal</title>
      <PageHeader
        title="Primitives showcase"
        description="Development only. The shadcn/ui primitives on the Melarc tokens. Every example here is synthetic and none of it is product data."
        actions={<ThemeSwitch />}
      />
      <ButtonsAndBadges />
      <Fields />
      <Cards />
      <Section title="Table">
        <DataTableDemo />
      </Section>
      <Overlays />
      <Dates />
      <Loading />
      <Toaster closeButton />
    </TooltipProvider>
  );
}
