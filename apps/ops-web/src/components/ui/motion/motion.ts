/**
 * The one door to Motion (the `motion` package, motion.dev), for the components of `components/ui` that animate in JavaScript: a layout that moves, a
 * panel that comes and goes, a number that counts up. A page never imports it (an ESLint rule and `test/motion-door.test.ts`), and no component writes a
 * duration or an easing of its own: they come from `useMotion`, which reads the tokens. What a stylesheet can do on the tokens is left to it
 * (COMPONENT_PATTERNS, *Motion*).
 */
export { AnimatePresence, animate, motion } from 'motion/react';
export { useMotion, usePrefersReducedMotion, type Motion } from './use-motion';
