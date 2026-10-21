# Escalation (gdy repair/review loop nie dowiózł po max 3 próbach albo bloker pre-mortem)

Zatrzymaj pracę i nie commituj do czasu odpowiedzi architekta.

```markdown
## Powód eskalacji
[Repair Loop (4. fail verify.sh) | Review Loop (Runda 3/3 Request changes) | Pre-Mortem Bloker]

## Problem
1-2 zdania.

## Tried (historie prób 1..3)
1. ...
2. ...
3. ...

## Evidence
Logi z `scripts/verify.sh` / werdykt Reviewera z Rundy 3 (output, nie parafraza).

## Hipoteza
Najbardziej prawdopodobna przyczyna źródłowa.

## Opcje
A) ... (koszt / ryzyko)
B) ...

## Rekomendacja
Opcja X, ponieważ ...

## Decyzja potrzebna
Jedno konkretne pytanie.
```
