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
      <h1 style={{ fontSize: '2.25rem', marginBottom: '0.5rem' }}>NightPay Admin</h1>
      <p style={{ color: '#666', marginTop: 0 }}>Panel de gestión · Sprint 1 scaffold</p>
      <p style={{ marginTop: '2rem', maxWidth: '36rem', lineHeight: 1.5 }}>
        Dashboard de venues, pagos, reembolsos y reportes. Implementación real en Sprint 6.
      </p>
    </main>
  );
}
