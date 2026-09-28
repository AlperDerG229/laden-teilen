// Placeholder shell. The kiosk (/#/wallbox), guest (/#/charge) and owner (/#/owner) screens
// are built in WP2/WP3 on top of src/core.
export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '0 auto', padding: 16 }}>
      <h1>Laden teilen</h1>
      <p>Pay-as-you-charge for private wallboxes. EURC micro-payments on Solana (devnet).</p>
      <p>Devnet prototype with a simulated charger. No real energy is sold and the tokens have no value.</p>
    </main>
  )
}
