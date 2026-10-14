# SHIT-Game – Would you rather…?

Live-Voting-Website für das „SHIT Meeting“. Spieler voten pro Frage dreimal (eigene Wahl, Mehrheit, Host), die Seite berechnet die Punkte (max. 70).

- **Frontend:** statisch in [public/](public) (Vercel)
- **Backend:** Node + Socket.IO in [server/](server) (Render). Der Server liefert `public/` auch selbst aus, Render allein reicht also zum Spielen.
- Fragen: [server/questions.json](server/questions.json) (Texte aus der PPP, Bilder/GIFs wurden durch Emojis ersetzt)

## Spielablauf
- Spieler öffnen die Seite und geben einen Namen ein (mind. 25, Standard-Limit 100).
- Host öffnet `/#admin`, loggt sich mit `ADMIN_PASSWORD` ein, startet Fragen, wählt seine eigene Option (A/B) und deckt auf.
- 60 s Zeit pro Frage (`VOTE_SECONDS`).

## Punkte
| | |
|---|---|
| Mehrheit richtig | 2 |
| Host richtig | 2 |
| Beides richtig | +1 |
| Comeback (≥1 richtig nach 3 komplett falschen Fragen) | +3 |
| Streak (ab der 4. komplett richtigen Frage in Folge) | +1 je weitere Frage |
| Maximum | 70 (Geschenk 🎁) |

Bei Gleichstand der eigenen Wahl gibt es keine „Mehrheit“ (niemand bekommt Mehrheitspunkte). Nicht abgegebene Votes zählen nicht als „falsch“, unterbrechen aber die Streak.

## Deployment
**Render** (Backend): New → Blueprint auf dieses Repo (`render.yaml`), Env `ADMIN_PASSWORD` setzen. URL z. B. `https://shit-game.onrender.com`.

**Vercel** (Frontend): Repo importieren, Env `BACKEND_URL=https://<render-url>` setzen. `vercel.json` kümmert sich um Build/Output.

Hinweis: Render Free schläft nach Inaktivität ein – vor dem Meeting die Seite einmal öffnen (`/health`). Spielstand liegt im RAM und geht bei Neustart verloren.

## Lokal
```
npm install
npm start      # http://localhost:3000, Admin: http://localhost:3000/#admin (Standard-Passwort "host")
npm test
```
