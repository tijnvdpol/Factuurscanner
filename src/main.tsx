import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AuthPoort from './components/AuthPoort.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* key: bij wisselen van gebruiker wordt alle app-state gereset */}
    <AuthPoort>{(sessie) => <App key={sessie.user.id} sessie={sessie} />}</AuthPoort>
  </StrictMode>,
)
