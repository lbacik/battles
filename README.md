# PÓLIS — prototyp UI antycznych bitew

Jednorazowy eksperyment interfejsu, nie kod produkcyjny. Trzy układy tej samej aplikacji pozwalają sprawdzić **jak połączyć definiowanie szyku, zarządzanie formacjami na mapie i przygotowanie terenu w grze turowej**.

## Uruchomienie

Wymagany Node.js. Bez instalowania zależności:

```sh
npm run prototype
```

Otwórz <http://localhost:4173/prototype/?variant=A>.

| Wariant | Pytanie projektowe | Adres |
| --- | --- | --- |
| A · Stół taktyczny | Czy lista armii, mapa i stały inspektor tworzą wygodny widok dowodzenia? | <http://localhost:4173/prototype/?variant=A> |
| B · Pole bitwy | Czy mapa z nakładanymi panelami daje lepszą orientację przestrzenną? | <http://localhost:4173/prototype/?variant=B> |
| C · Warsztat scenariusza | Czy biblioteka formacji, rejestr rozkazów i dolny inspektor ułatwiają przygotowanie potyczki? | <http://localhost:4173/prototype/?variant=C> |

Przełącznik na dole lub strzałki ← / → zmieniają wariant bez resetowania stanu. Parametr adresu zachowuje wybrany układ przy odświeżeniu. Przełącznik jest dostępny tylko na localhost.

## Co można sprawdzić

- Tworzenie i edycję formacji: nazwa, strona, typ, liczebność, pliki, szeregi i odstępy; podgląd ustawienia.
- Wybieranie oddziałów na mapie lub liście; zmianę szyku, obrót, powielanie i usuwanie.
- Planowanie ruchu przez przeciągnięcie oddziału lub wskazanie celu. Strzałka i przezroczysta formacja pokazują przyszłą pozycję.
- Jednoczesne wykonanie rozkazów przyciskiem „Wykonaj turę”, utrzymanie pozycji i anulowanie planu.
- Dodawanie wzgórz, lasów, zabudowań, trudnego terenu, jezior i rzek. Pędzel działa kliknięciem lub przeciągnięciem; wielokąty i rzeki wyznacza się punktami i zatwierdza przyciskiem lub Enterem.
- Edycję wysokości wzgórza i szerokości rzeki oraz usuwanie terenu.
- Przesuwanie i powiększanie mapy, siatkę, etykiety i warstwice; cofanie zmian.
- Pełny stan w przycisku „Stan” oraz w konsoli po każdej zmianie widoku.

Skróty: **V** wybieranie, **H** przesuwanie mapy, **M** rozkaz ruchu, **Esc** anulowanie, **⌘/Ctrl Z** cofnięcie.

## Założenia eksperymentu

Stan żyje wyłącznie w pamięci. Odświeżenie strony przywraca scenariusz. Oba obozy kontroluje użytkownik, aby porównać interakcje. Przykład jest fikcyjnym ustawieniem inspirowanym antykiem, bez ambicji rekonstrukcji historycznej.

Ruch czeka na wykonanie tury; edycja szyku i terenu działa natychmiast. Nie ma jeszcze walki, kolizji, ścieżkowania, limitów ruchu ani wpływu terenu. Formacje są symbolami powiększonymi względem skali mapy. Liczebność i liczba znaczników w schemacie są niezależne.

## Wynik i dalsza decyzja

**Status: do oceny przez użytkownika; żaden wariant nie został jeszcze zatwierdzony.** A jest punktem startowym do rozmowy: wszystkie narzędzia dowodzenia są stale dostępne. B sprawdza skupienie na mapie, a C — pracę nad scenariuszem. Można połączyć wybrane elementy po porównaniu.

Źródło prototypu znajduje się w `prototype/`. Pozostaje eksperymentem do odrzucenia; wybrany kierunek wymaga oddzielnej implementacji produkcyjnej. Nie ma jeszcze zgłoszenia implementacyjnego, do którego można przypiąć decyzję.

## Weryfikacja

Sprawdzone ręcznie w przeglądarce: tworzenie formacji, wybór na mapie, plan ruchu kliknięciem i przeciągnięciem, wykonanie tury, rysowanie rzeki oraz przenoszenie stanu pomiędzy trzema wariantami. Układy sprawdzono w podglądzie desktopowym i wąskim. Sprawdzona składnia JavaScript; zgodnie ze skalą prototypu brak automatycznych testów i zależności.
