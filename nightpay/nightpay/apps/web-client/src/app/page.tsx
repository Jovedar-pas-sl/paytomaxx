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
      <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>NightPay</h1>
      <p style={{ color: '#999', marginTop: 0 }}>Web cliente · Sprint 1 scaffold</p>
      <p style={{ marginTop: '2rem', maxWidth: '28rem', lineHeight: 1.5 }}>
        Escanea un QR generado por el TPV para comenzar un pago. Esta página inicial es solo un
        placeholder hasta Sprint 5 (UX del cliente móvil).
      </p>
    </main>
  );
}
