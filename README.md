# prawojazdy-bot

Prosty i czytelny szkielet aplikacji Node.js do monitorowania terminow egzaminu prawa jazdy.

## Co robi teraz

- czyta konfiguracje z `.env`
- uruchamia Playwright
- wchodzi na `TARGET_URL`
- loguje tytul strony
- zapisuje wynik do `state.json`
- loguje mock powiadomienia

## Konfiguracja

Skopiuj `.env.example` do `.env` i ustaw:

- `TARGET_URL`
- `PLAYWRIGHT_BROWSER`
- `PLAYWRIGHT_HEADLESS`
- `STATE_FILE`

## Uruchomienie

```bash
npm start
```
