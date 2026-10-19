import type { Route } from 'next';
import { notFound, redirect } from 'next/navigation';
import { customerPageUrl, isQrToken } from '@/lib/customer-pages';

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
}

/** El cobro lo hace la página del API (tarjeta, propina, saldo, Face ID): aquí solo se redirige. */
export default async function PayPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isQrToken(params.token)) notFound();
  // URL absoluta del API: typedRoutes (Next 15.5) también tipa redirect().
  redirect(customerPageUrl('pay', params.token, searchParams.lang) as Route);
}
