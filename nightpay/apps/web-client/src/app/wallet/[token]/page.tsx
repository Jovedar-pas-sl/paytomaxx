import { notFound, redirect } from 'next/navigation';
import { customerPageUrl, isQrToken } from '@/lib/customer-pages';

interface PageProps {
  params: { token: string };
  searchParams: { lang?: string | string[] };
}

/** El saldo del cliente lo muestra el API (/w/:token): aquí solo se redirige. */
export default function WalletPage({ params, searchParams }: PageProps) {
  if (!isQrToken(params.token)) notFound();
  redirect(customerPageUrl('w', params.token, searchParams.lang));
}
