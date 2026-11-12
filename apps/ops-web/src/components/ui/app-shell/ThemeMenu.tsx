import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { Icon } from '../icon/Icon';
import { IconButton } from '../icon-button/IconButton';
import { isThemeValue, THEME_OPTIONS, type ThemeValue } from './theme-options';
import './top-bar.css';

/**
 * The theme control of the top bar (redesign step R4; PRODUCT_DESIGN_DIRECTION section 7): an icon button that says which theme the person has
 * chosen (System, Light or Dark) and opens a menu of the three. System is the default and follows the operating system's setting; the other two
 * are the person's own choice, kept by the platform (`platform/theme`), which is also what the account menu offers. This only draws the choice it is
 * given and tells which one was made.
 */
export function ThemeMenu({
  choice,
  onChoose,
}: {
  readonly choice: ThemeValue;
  readonly onChoose: (choice: ThemeValue) => void;
}) {
  const current = THEME_OPTIONS.find((option) => option.value === choice) ?? THEME_OPTIONS[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          type="button"
          variant="bare"
          icon={current?.icon ?? 'theme-system'}
          label={`Theme: ${current?.label ?? 'System'}`}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="ui-menu">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(value) => {
            if (isThemeValue(value)) onChoose(value);
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <Icon name={option.icon} size="sm" />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
