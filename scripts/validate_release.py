"""Validate the public NorCal Atlas package before release.

This checks the committed analytical extract, executed notebook, static Atlas
snapshot, model-family parity, and the public/private language boundary.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import nbformat
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler


ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "data" / "norcal_public_data.csv"
NOTEBOOK_PATH = ROOT / "notebooks" / "NorCal_Atlas_Geodemographic_Segmentation.ipynb"
ATLAS_DATA_PATH = ROOT / "assets" / "atlas-data.js"

FEATURES = [
    "median_hh_income",
    "pct_ba_plus",
    "pct_asian_nh",
    "pct_hispanic",
    "median_age",
    "log_density",
    "owner_occupied_pct",
    "avg_vehicles_per_hh",
    "pct_hh_with_kids",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def parse_atlas_constant(source: str, name: str, next_name: str | None) -> object:
    end = rf"\nconst {next_name} =" if next_name else r"\n?$"
    match = re.search(rf"const {name} = (.*?);{end}", source, flags=re.DOTALL)
    require(match is not None, f"Could not parse {name} from Atlas data")
    return json.loads(match.group(1))


def family_assignments(data: pd.DataFrame) -> dict[str, str]:
    model_data = data.loc[data["population"] >= 1_000].dropna(subset=FEATURES).copy()
    values = model_data[FEATURES].to_numpy(dtype=float)
    scaled = StandardScaler().fit_transform(values)
    labels = KMeans(n_clusters=5, init="k-means++", n_init=25, random_state=42).fit(scaled).labels_

    profiles = {
        label: dict(zip(FEATURES, values[labels == label].mean(axis=0)))
        for label in sorted(set(labels))
    }
    rules = [
        ("High-income technology suburbs", lambda p: p["median_hh_income"] > 140_000 and p["pct_asian_nh"] > 25),
        ("Dense renter cities", lambda p: np.exp(p["log_density"]) > 3_000 and p["owner_occupied_pct"] < 45),
        ("Rural and small-town owners", lambda p: np.exp(p["log_density"]) < 200 and p["median_age"] > 47),
        ("Younger Valley families", lambda p: p["pct_hispanic"] > 60 and p["median_age"] < 34),
    ]
    names: dict[int, str] = {}
    for family, rule in rules:
        matches = [label for label, profile in profiles.items() if rule(profile)]
        require(len(matches) == 1, f"Naming rule for {family} no longer identifies one group")
        names[matches[0]] = family
    residual = [label for label in profiles if label not in names]
    require(len(residual) == 1, "Expected one residual family")
    names[residual[0]] = "Middle-income suburbs"
    return dict(zip(model_data["zcta"].astype(str).str.zfill(5), (names[label] for label in labels)))


def notebook_text(notebook: nbformat.NotebookNode) -> str:
    chunks: list[str] = []
    for cell in notebook.cells:
        chunks.append(cell.source)
        for output in cell.get("outputs", []):
            if output.get("output_type") == "stream":
                chunks.append(output.get("text", ""))
            for mime, value in output.get("data", {}).items():
                if mime.startswith("text/"):
                    chunks.append("".join(value) if isinstance(value, list) else str(value))
    return "\n".join(chunks)


def main() -> None:
    data = pd.read_csv(CSV_PATH, dtype={"zcta": "string"})
    data["zcta"] = data["zcta"].str.zfill(5)
    require(data.shape == (1_045, 22), f"Unexpected CSV shape: {data.shape}")
    require(data["zcta"].is_unique, "CSV contains duplicate ZCTAs")

    notebook = nbformat.read(NOTEBOOK_PATH, as_version=4)
    code_cells = [cell for cell in notebook.cells if cell.cell_type == "code"]
    require(len(notebook.cells) == 35 and len(code_cells) == 17, "Notebook structure drifted")
    require(all(cell.get("execution_count") is not None for cell in code_cells), "Notebook has unexecuted code cells")
    require(
        not any(output.get("output_type") == "error" for cell in code_cells for output in cell.get("outputs", [])),
        "Notebook contains an error output",
    )

    atlas_source = ATLAS_DATA_PATH.read_text()
    geo = parse_atlas_constant(atlas_source, "GEO", "COUNTIES")
    counties = parse_atlas_constant(atlas_source, "COUNTIES", "COUNTY_GEO")
    county_geo = parse_atlas_constant(atlas_source, "COUNTY_GEO", "CHARGERS")
    chargers = parse_atlas_constant(atlas_source, "CHARGERS", None)
    require(len(geo["features"]) == 1_045, "Atlas ZIP count drifted")
    require(len(counties) == len(county_geo["features"]) == 50, "Atlas county count drifted")
    require(len(chargers) == 9_244, "Atlas charger count drifted")

    atlas_rows = pd.DataFrame(feature["properties"] for feature in geo["features"])
    atlas_rows["zcta"] = atlas_rows["zcta"].astype(str).str.zfill(5)
    shared = [column for column in data.columns if column in atlas_rows.columns and column not in {"zcta", "county"}]
    merged = data.merge(atlas_rows[["zcta", "county", *shared]], on="zcta", suffixes=("_csv", "_atlas"), validate="one_to_one")
    require(len(merged) == 1_045, "CSV and Atlas ZCTAs do not reconcile")
    normalized_atlas_counties = merged["county_atlas"].str.removesuffix(" County")
    require((merged["county_csv"] == normalized_atlas_counties).all(), "County labels do not reconcile")
    for column in shared:
        left = pd.to_numeric(merged[f"{column}_csv"], errors="coerce")
        right = pd.to_numeric(merged[f"{column}_atlas"], errors="coerce")
        require(np.allclose(left, right, equal_nan=True, atol=1e-9), f"Shared field drift: {column}")

    expected_families = family_assignments(data)
    atlas_families = (
        atlas_rows.loc[atlas_rows["sc_parent"].astype(str).str.len() > 0]
        .set_index("zcta")["sc_parent"]
        .to_dict()
    )
    require(expected_families == atlas_families, "Notebook model and Atlas family assignments drifted")

    # Assemble private-boundary tokens without embedding them verbatim in this public file.
    blocked = [
        "".join(map(chr, [97, 97, 97])),
        "".join(map(chr, [109, 119, 103, 46, 97, 97, 97])),
        "".join(map(chr, [109, 101, 109, 98, 101, 114, 45, 103, 114, 111, 119, 116, 104])),
        "".join(map(chr, [109, 101, 109, 98, 101, 114, 115, 104, 105, 112])),
        "".join(map(chr, [105, 110, 116, 101, 114, 110, 97, 108, 32, 103, 111, 111, 103, 108, 101])),
        "".join(map(chr, [109, 101, 109, 98, 101, 114, 32, 100, 97, 116, 97])),
    ]
    text_suffixes = {".csv", ".html", ".js", ".md", ".py", ".txt"}
    public_files = [path for path in ROOT.rglob("*") if path.is_file() and path.suffix.lower() in text_suffixes]
    public_text = "\n".join([*(path.read_text(errors="replace") for path in public_files), notebook_text(notebook)]).lower()
    for token in blocked:
        require(token not in public_text, f"Blocked private-language token found: {token}")

    print("PASS: 1,045 CSV and Atlas ZIPs reconcile")
    print(f"PASS: {len(shared)} shared presentation fields reconcile")
    print("PASS: 748 notebook and Atlas family assignments reconcile")
    print("PASS: notebook is fully executed with no error outputs")
    print("PASS: public/private language boundary is clean")


if __name__ == "__main__":
    main()
