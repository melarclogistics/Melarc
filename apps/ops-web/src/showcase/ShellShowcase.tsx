// eslint-disable-next-line no-restricted-imports -- the older PageHeader: this screen moves to the kit's when it is rebuilt (task R5.2, M12)
import { PageHeader } from '../components/PageHeader';
import { ShellDemos } from './ShellDemos';
import './showcase.css';

/**
 * The shell of the signed-in screens, beside the components and the primitives (`/__showcase/shell`; redesign step R4; COMPONENT_PATTERNS section 27):
 * the sidebar expanded and as the rail, the top bar with its menus, and the command palette in each state of its search, drawn with made-up
 * entries that go nowhere. It has a page of its own because the checks of the components' page (the Tab walk, the reflow at 320px, the text at
 * 200%) are about components, and the shell is not a component of that kind. The production build holds no trace of it (the route is gated as the
 * other two are, and `test/build.test.ts` proves it).
 */
export function ShellShowcasePage() {
  return (
    <>
      <title>Shell showcase · Melarc Ops Portal</title>
      <PageHeader
        title="Shell showcase"
        description="Development only. The sidebar, the top bar and the command palette of the signed-in screens, with made-up entries. Every example here is synthetic and none of it is product data."
      />
      <ShellDemos />
    </>
  );
}
