export default function Page() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>NightPay TPV</h1>
      <p style={{ color: '#aaa', marginTop: 0 }}>Terminal del camarero · Sprint 1 scaffold</p>
      <p style={{ marginTop: '2rem', maxWidth: '36rem', lineHeight: 1.5 }}>
        Aquí vivirá la interfaz de cobro: introducir importe, generar QR, mostrar estado del pago.
        Implementación real en Sprint 5.
      </p>
    </main>
  );
}
