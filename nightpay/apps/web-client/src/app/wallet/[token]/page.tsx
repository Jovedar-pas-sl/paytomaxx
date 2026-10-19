import type { Route } from 'next';
import { notFound, redirect } from 'next/navigation';
import { customerPageUrl, isQrToken } from '@/lib/customer-pages';

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
}

/** El saldo del cliente lo muestra el API (/w/:token): aquí solo se redirige. */
export default async function WalletPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isQrToken(params.token)) notFound();
  // URL absoluta del API: typedRoutes (Next 15.5) también tipa redirect().
  redirect(customerPageUrl('w', params.token, searchParams.lang) as Route);
}
