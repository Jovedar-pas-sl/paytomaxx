import { SelfOnboardingClient } from './SelfOnboardingClient';

interface PageProps {
  params: { token: string };
}

/**
 * Self-onboarding page — la chica abre el link único del admin (TTL 72h)
 * y rellena su perfil ella sola. Sin login (token en path es la cred).
 */
export default function SelfOnboardingPage({ params }: PageProps) {
  return <SelfOnboardingClient token={params.token} />;
}
