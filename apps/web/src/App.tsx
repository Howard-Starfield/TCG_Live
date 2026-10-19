import { AppRoot } from './app/AppRoot';
import { createAdminData } from './data';

// One data layer per page, created outside render.
const data = createAdminData();

export function App() {
  return <AppRoot data={data} />;
}
