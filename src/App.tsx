import { useEffect } from 'react';
import { AppEnvContext, type AppEnv } from './ui/app-context.tsx';
import { CaptionBar, MockBanner } from './ui/components/chrome.tsx';
import { How } from './ui/pages/How.tsx';
import { Landing } from './ui/pages/Landing.tsx';
import { OwnerDashboard } from './ui/pages/OwnerDashboard.tsx';
import { OwnerSetup } from './ui/pages/OwnerSetup.tsx';
import { Charge, Demo, NotFound, Wallbox } from './ui/pages/routes.tsx';
import { useRoute } from './ui/router.ts';

const TITLES: Record<string, string> = {
  '/': 'Laden teilen · pay-as-you-charge for private wallboxes',
  '/owner': 'Set up your wallbox · Laden teilen',
  '/owner/dashboard': 'Owner dashboard · Laden teilen',
  '/wallbox': 'Wallbox display · Laden teilen',
  '/charge': 'Charge · Laden teilen',
  '/demo': 'Split-screen demo · Laden teilen',
  '/how': 'How it works · Laden teilen',
};

export default function App({ env }: { env: AppEnv }) {
  const { path, params } = useRoute();

  useEffect(() => {
    document.body.classList.toggle('has-mock', env.flags.mock);
    document.body.classList.toggle('has-captions', env.flags.captions);
  }, [env.flags.mock, env.flags.captions]);

  useEffect(() => {
    document.title = `${env.flags.mock ? '[MOCK] ' : ''}${TITLES[path] ?? 'Laden teilen'}`;
    window.scrollTo(0, 0);
  }, [path, env.flags.mock]);

  let page;
  switch (path) {
    case '/':
      page = <Landing />;
      break;
    case '/owner':
      page = <OwnerSetup params={params} />;
      break;
    case '/owner/dashboard':
      page = <OwnerDashboard params={params} />;
      break;
    case '/wallbox':
      page = <Wallbox params={params} />;
      break;
    case '/charge':
      page = <Charge params={params} />;
      break;
    case '/demo':
      page = <Demo params={params} />;
      break;
    case '/how':
      page = <How />;
      break;
    default:
      page = <NotFound />;
  }

  return (
    <AppEnvContext.Provider value={env}>
      {env.flags.mock && env.flags.mockSource && <MockBanner source={env.flags.mockSource} />}
      {page}
      <CaptionBar enabled={env.flags.captions} />
    </AppEnvContext.Provider>
  );
}
