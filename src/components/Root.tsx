import { useEffect, useState } from "react";
import App from "../App";
import { leesMailActieHash } from "../lib/notificaties";
import AuthPoort from "./AuthPoort";
import MailActiePagina from "./MailActiePagina";
import OrganisatiePoort from "./OrganisatiePoort";

/** Een link uit een goedkeuringsmail (#mail-actie=…) werkt zonder inloggen; al het andere via de AuthPoort. */
export default function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const bijWijziging = () => setHash(window.location.hash);
    window.addEventListener("hashchange", bijWijziging);
    return () => window.removeEventListener("hashchange", bijWijziging);
  }, []);

  const mailActie = leesMailActieHash(hash);
  if (mailActie) return <MailActiePagina key={mailActie.token} token={mailActie.token} keuze={mailActie.keuze} />;

  return (
    // key: bij wisselen van gebruiker of organisatie wordt alle app-state gereset
    <AuthPoort>
      {(sessie) => (
        <OrganisatiePoort key={sessie.user.id} sessie={sessie}>
          {(context) => <App key={context.lidmaatschap.organisatie_id} sessie={sessie} {...context} />}
        </OrganisatiePoort>
      )}
    </AuthPoort>
  );
}
