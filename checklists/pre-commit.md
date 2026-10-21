# Pre-commit / pre-push — kombain.pl

- [ ] Plan TERAZ z `docs/plans.md` w pełni zrobiony (DoD + testy); KIEDYŚ nietknięte
- [ ] `docs/plans.md` / `docs/STATUS.md` spójne (zaktualizowane PRZED ostatnim `verify.sh` i Reviewerem)
- [ ] `scripts/verify.sh` → `exit 0` po OSTATNIEJ modyfikacji plików
- [ ] Repair loop: reproduce → minimal fix → regression test → max 3 → escalation
- [ ] Reviewer: po ostatnim `verify.sh` werdykt `Approve` (poprawki → nowy `verify.sh` + nowa runda)
- [ ] Brak zmian poza scope; brak refaktora „przy okazji"
- [ ] Brak nowych dep bez uzasadnienia w briefie; brak zmian DDL/API bez zgody
- [ ] `git status` / `git diff --cached` — tylko pliki taska
- [ ] Brak `.env`, kluczy LLM/scrape, JWT, `*.pem`, `*.sqlite` w diffie kodu
- [ ] SQL tylko parametryzowane (`$1`), brak `{{ }}`; `source_url` z wejścia, nie z dumpa
- [ ] Prompty: brak `[WPISZ]`, brak `PocketBase`, kategoria w enum 6, `title≤60`, HTML allowlist
- [ ] Stany: `rejected` tylko permanentne, review-faile → `draft + needs_human_check` (retry przez `ON CONFLICT DO UPDATE`)
- [ ] Conventional Commit, 1 task = 1 commit
- [ ] `git push origin` (bez `--force`, bez `--no-verify`)
