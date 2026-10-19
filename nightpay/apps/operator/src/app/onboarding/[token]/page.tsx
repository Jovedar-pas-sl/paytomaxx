import { SelfOnboardingClient } from './SelfOnboardingClient';

interface PageProps {
  params: Promise<{ token: string }>;
}

/**
 * Self-onboarding page — la chica abre el link único del admin (TTL 72h)
 * y rellena su perfil ella sola. Sin login (token en path es la cred).
 */
export default async function SelfOnboardingPage(props: PageProps) {
  const params = await props.params;
  return <SelfOnboardingClient token={params.token} />;
}
