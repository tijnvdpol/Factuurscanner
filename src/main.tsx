import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AuthPoort from './components/AuthPoort.tsx'
import OrganisatiePoort from './components/OrganisatiePoort.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* key: bij wisselen van gebruiker of organisatie wordt alle app-state gereset */}
    <AuthPoort>
      {(sessie) => (
        <OrganisatiePoort key={sessie.user.id} sessie={sessie}>
          {(context) => <App key={context.lidmaatschap.organisatie_id} sessie={sessie} {...context} />}
        </OrganisatiePoort>
      )}
    </AuthPoort>
  </StrictMode>,
)
