# prawojazdy-bot

Prosty szkielet aplikacji Node.js do monitorowania terminow egzaminu prawa jazdy z uzyciem Playwright.

## Zalecenia projektu

- jeden uzytkownik
- brak bazy danych
- brak frontendu
- konfiguracja przez `.env`
- stan aplikacji w `state.json`
- logika w katalogu `src`

## Struktura

```text
src/
  checker.js
  config.js
  index.js
  logger.js
  notify.js
  parser.js
  storage.js
```

## Konfiguracja

1. Skopiuj `.env.example` do `.env`.
2. Uzupelnij wartosci zmiennych srodowiskowych.

Przykladowe zmienne:

- `TARGET_URL` - adres strony do sprawdzania
- `PLAYWRIGHT_BROWSER` - `chromium`, `firefox` lub `webkit`
- `PLAYWRIGHT_HEADLESS` - `true` albo `false`
- `STATE_FILE` - sciezka do pliku ze stanem, domyslnie `state.json`
- `NOTIFICATION_CHANNEL` - kanal powiadomien, obecnie placeholder
- `DRY_RUN` - gdy `true`, aplikacja nie wysyla powiadomien

## Uruchomienie

```bash
npm start
```

## Co jest zaimplementowane teraz

- start aplikacji z `src/index.js`
- ladowanie konfiguracji z `.env`
- podstawowy logger
- odczyt i zapis `state.json`
- uruchomienie Playwright
- placeholder parsera i notyfikacji

## Co pozostaje do dopisania

- konkretna logika logowania i nawigacji po stronie docelowej
- parsowanie terminow egzaminow
- warunki wysylki powiadomien
