#!/usr/bin/env python3
"""
Deduplica y fusiona clientes en shared_db.json.

Reglas:
- Misma maquina + mismo nombre     → duplicado puro, eliminar copia extra
- Misma maquina + diferente nombre → nombre comercial + nombre juridico,
                                     fusionar en un solo cliente
- Clientes _especiales              → no participan en la fusion;
                                     se les quitan las maquinas que
                                     ya quedan asignadas a clientes reales
"""

import json, uuid, re
from collections import defaultdict
from pathlib import Path

DB = Path(__file__).parent / "shared_db.json"
LEGAL_RE = re.compile(
    r'\b(SL|SLU|SRL|SA|SAU|BV|NV|LDA|SPRL|SCS|SCP|LLC|GMBH|CO)\b',
    re.IGNORECASE
)

def load():
    with open(DB, encoding='utf-8') as f:
        return json.load(f)

def save(db):
    with open(DB, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

def is_legal(name):
    return bool(LEGAL_RE.search(name))

def best_name(names):
    """Elige el nombre principal: primero los juridicos, si hay varios
    el mas largo; si no hay ninguno juridico, el mas largo."""
    legal = [n for n in names if is_legal(n)]
    pool = legal if legal else names
    return max(pool, key=len)

def merge_machines(all_machines):
    """Deduplica maquinas por machineId. Cuando hay duplicado, conserva
    el que tiene mas datos (incidents + components)."""
    seen = {}
    for m in all_machines:
        mid = m['machineId']
        if mid not in seen:
            seen[mid] = m
        else:
            # Conservar el que tiene mas datos
            existing = seen[mid]
            score_new = len(m.get('incidents', [])) + len(m.get('components', []))
            score_old = len(existing.get('incidents', [])) + len(existing.get('components', []))
            if score_new > score_old:
                # Preserve id from existing but take richer data
                m['id'] = existing['id']
                seen[mid] = m
    return list(seen.values())

def richness(client):
    """Cuenta campos no vacios para elegir quien aporta los metadatos."""
    fields = ['contact', 'cif', 'phone', 'email', 'address', 'city', 'notes']
    return sum(1 for f in fields if client.get(f, '').strip())

def merge_clients(group):
    """Fusiona una lista de clientes en uno solo."""
    if len(group) == 1:
        return group[0]

    names = [c['name'] for c in group]
    primary_name = best_name(names)
    aliases = [n for n in names if n != primary_name]

    # Aporta metadatos el mas completo
    base = max(group, key=richness)

    all_machines = []
    for c in group:
        all_machines.extend(c.get('machines', []))

    merged = {
        'id':      base.get('id') or str(uuid.uuid4())[:8],
        'name':    primary_name,
        'aliases': aliases,
        'contact': base.get('contact', ''),
        'cif':     base.get('cif', ''),
        'phone':   base.get('phone', ''),
        'email':   base.get('email', ''),
        'address': base.get('address', ''),
        'city':    base.get('city', ''),
        'country': base.get('country', 'España'),
        'notes':   base.get('notes', ''),
        'machines': merge_machines(all_machines),
    }
    return merged

# ─── Union-Find ────────────────────────────────────────────────────────────────
def make_uf(n):
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[b] = a
    return find, union

# ─── Main ──────────────────────────────────────────────────────────────────────
def main():
    db = load()
    clients = db['clients']
    n = len(clients)

    is_special = [c['name'].startswith('_especiales') for c in clients]

    find, union = make_uf(n)

    # Build machine → [client indices] map
    machine_to_idx = defaultdict(list)
    for i, c in enumerate(clients):
        for m in c.get('machines', []):
            machine_to_idx[m['machineId']].append(i)

    # Union non-special clients that share a machine
    for mid, idxs in machine_to_idx.items():
        real = [i for i in idxs if not is_special[i]]
        for j in range(1, len(real)):
            union(real[0], real[j])

    # Group by root
    groups = defaultdict(list)
    for i, c in enumerate(clients):
        if not is_special[i]:
            groups[find(i)].append(c)

    # Build new real client list
    new_real = []
    for root, group in groups.items():
        merged = merge_clients(group)
        new_real.append(merged)

    # Collect all machineIds that now belong to real clients
    real_machine_ids = set()
    for c in new_real:
        for m in c.get('machines', []):
            real_machine_ids.add(m['machineId'])

    # Clean up specials: remove machines already owned by real clients
    new_specials = []
    for c in clients:
        if not c['name'].startswith('_especiales'):
            continue
        kept_machines = [
            m for m in c.get('machines', [])
            if m['machineId'] not in real_machine_ids
        ]
        if kept_machines:
            c['machines'] = kept_machines
            new_specials.append(c)
        else:
            print(f"  Eliminando bucket vacio: {c['name']}")

    db['clients'] = new_real + new_specials

    # Stats
    merges = sum(1 for g in groups.values() if len(g) > 1)
    total_before = len(clients)
    total_after  = len(db['clients'])
    print(f"Clientes antes : {total_before}")
    print(f"Clientes despues: {total_after}  (fusionados {merges} grupos)")
    total_machines = sum(len(c.get('machines', [])) for c in db['clients'])
    print(f"Maquinas totales: {total_machines}")

    # Show merged groups for review
    print()
    print("== Grupos fusionados ==")
    for root, group in sorted(groups.items(), key=lambda x: -len(x[1])):
        if len(group) > 1:
            names = [c['name'] for c in group]
            primary = best_name(names)
            others = [n for n in names if n != primary]
            mids = []
            for c in group:
                mids.extend(m['machineId'] for m in c.get('machines', []))
            mids_uniq = list(dict.fromkeys(mids))
            print(f"  {primary}")
            for o in others:
                print(f"    <- {o}")
            print(f"     maquinas: {mids_uniq}")

    save(db)
    print()
    print("shared_db.json guardado.")

if __name__ == '__main__':
    main()
