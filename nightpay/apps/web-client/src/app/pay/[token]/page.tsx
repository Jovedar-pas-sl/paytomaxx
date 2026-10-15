import { notFound, redirect } from 'next/navigation';
import { customerPageUrl, isQrToken } from '@/lib/customer-pages';

interface PageProps {
  params: { token: string };
  searchParams: { lang?: string | string[] };
}

/** El cobro lo hace la página del API (tarjeta, propina, saldo, Face ID): aquí solo se redirige. */
export default function PayPage({ params, searchParams }: PageProps) {
  if (!isQrToken(params.token)) notFound();
  redirect(customerPageUrl('pay', params.token, searchParams.lang));
}
