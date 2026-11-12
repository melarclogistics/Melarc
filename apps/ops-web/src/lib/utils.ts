import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names and resolves the conflicts between Tailwind utilities, the later one winning (`cn('p-2', 'p-4')` is `p-4`). It is the
 * `utils` alias of `components.json`, which the shadcn primitives (`components/primitives/`) import. Melarc's own components
 * (`components/ui/`) use it when they compose a primitive with a class of their own.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
