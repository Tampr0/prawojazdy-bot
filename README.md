# prawojazdy-bot

Prosty bot Node.js do monitorowania terminow egzaminu prawa jazdy przez API.

## Co robi teraz

- probuje wczytac `session.json`
- jesli sesji brak, uruchamia Playwright i czeka na request do `exam-schedule`
- zapisuje Bearer token, cookies i user agent do `session.json`
- wywoluje endpoint `PUT /exam-schedule` zwyklym requestem HTTP
- parsuje tylko `practiceExams`
- zapisuje wynik do `debug-slots.json`

## Konfiguracja

Skopiuj `.env.example` do `.env` i ustaw:

- `TARGET_URL`
- `PLAYWRIGHT_BROWSER`
- `PLAYWRIGHT_HEADLESS`
- `CAPTURE_TIMEOUT_MS`
- `STATE_FILE`
- `SESSION_FILE`
- `DEBUG_SLOTS_FILE`
- `EXAM_SCHEDULE_URL`
- `EXAM_SCHEDULE_PAYLOAD_JSON`

## Uruchomienie

```bash
npm start
```
