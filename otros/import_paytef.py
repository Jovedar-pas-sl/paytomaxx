#!/usr/bin/env python3
"""
Import paytef_machines.csv into shared_db.json.
- Each unique establishment becomes one client entry.
- Machines are nested under their client.
- Existing clients (by name match) are updated with new machines;
  their existing incidents/components are preserved.
- Special names (BAJA, Averiado, Oficina, --) go into a synthetic
  "_especiales" client that won't show in main UI.
"""

import csv
import json
import uuid
from pathlib import Path

BASE = Path(__file__).parent
CSV_PATH  = BASE / "paytef_machines.csv"
DB_PATH   = BASE / "shared_db.json"

SPECIAL_NAMES = {"* BAJA *", "* Averiado *", "* Oficina *", "--"}

def new_id():
    return str(uuid.uuid4())[:8]

def load_db():
    if DB_PATH.exists():
        with open(DB_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"clients": []}

def save_db(db):
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

def parse_csv():
    machines_by_client = {}  # name -> list of machine dicts
    with open(CSV_PATH, "r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=";", quotechar='"')
        for row in reader:
            if len(row) < 8:
                continue
            _, establishment, full_id, short_code, mtype, rate, cassettes, active = row[:8]
            establishment = establishment.strip()
            short_code    = short_code.strip()
            full_id       = full_id.strip()
            mtype         = mtype.strip()   # "C" or "D"
            rate          = int(rate) if rate.isdigit() else 0
            cassettes     = int(cassettes) if cassettes.isdigit() else 2
            is_active     = active.strip() == "1"

            # Map type by serial prefix + C/D column
            serial_up = full_id.upper()
            short_up  = short_code.upper()
            if serial_up.startswith("TNA"):
                machine_type = "negro"
            elif serial_up.startswith("RNA") or short_up.startswith("RNA") \
                 or short_up.startswith("MAQUINA"):
                machine_type = "rojo"
            elif serial_up.startswith("RSR") or short_up.startswith("RSR"):
                # RSR: D = cajero negro, C = TPV/datafono
                machine_type = "negro" if mtype == "D" else "datafono"
            else:
                # fallback for JOL/BN/DBEL/INV/XT/etc: use C/D column
                machine_type = "negro" if mtype == "D" else "rojo"

            # Status
            if not is_active:
                if establishment == "* BAJA *":
                    status = "baja"
                elif establishment == "* Averiado *":
                    status = "averiado"
                else:
                    status = "inactive"
            else:
                status = "active"

            machine = {
                "id":           new_id(),
                "machineId":    short_code,
                "serialNumber": full_id,
                "location":     establishment if establishment not in SPECIAL_NAMES else short_code,
                "type":         machine_type,
                "paytefType":   mtype,
                "rate":         rate,
                "cassettes":    None if machine_type == "datafono" else cassettes,
                "status":       status,
                "components":   [],
                "incidents":    []
            }

            machines_by_client.setdefault(establishment, []).append(machine)

    return machines_by_client

def merge(db, machines_by_client):
    # Index existing clients by name for fast lookup
    existing = {c["name"]: c for c in db["clients"]}

    for establishment, machines in machines_by_client.items():
        # Determine display name
        if establishment in SPECIAL_NAMES:
            client_name = f"_especiales ({establishment})"
        else:
            client_name = establishment

        if client_name in existing:
            client = existing[client_name]
            # Build set of known machineIds so we don't duplicate
            known_ids = {m["machineId"] for m in client.get("machines", [])}
            for m in machines:
                if m["machineId"] not in known_ids:
                    client.setdefault("machines", []).append(m)
                    known_ids.add(m["machineId"])
        else:
            new_client = {
                "id":       new_id(),
                "name":     client_name,
                "contact":  "",
                "cif":      "",
                "phone":    "",
                "email":    "",
                "address":  "",
                "city":     "",
                "country":  "España",
                "notes":    "",
                "machines": machines
            }
            db["clients"].append(new_client)
            existing[client_name] = new_client

    return db

def main():
    print("Leyendo CSV...")
    machines_by_client = parse_csv()
    total_machines = sum(len(v) for v in machines_by_client.values())
    print(f"  {len(machines_by_client)} establecimientos, {total_machines} máquinas")

    print("Cargando shared_db.json...")
    db = load_db()
    before = len(db["clients"])

    print("Mergeando datos...")
    db = merge(db, machines_by_client)
    after = len(db["clients"])

    print(f"Guardando shared_db.json... ({before} -> {after} clientes)")
    save_db(db)

    print("Listo.")
    for name, machines in sorted(machines_by_client.items()):
        print(f"  {name:40s} -> {len(machines)} maquinas")

if __name__ == "__main__":
    main()
