"""Embed texts locally for the memory viewer.

    python -I otto/memembed.py <model>
    stdin, one JSON line per request:  {"texts": [...]}
    stdout, one JSON line per answer:  {"dim": N, "device": "mps", "vectors": "<base64 float32>"}

Run by memviewer.ts with whichever venv has torch + transformers (see README):
once per build for the memories that changed, and kept running under --serve to
embed search queries. The model is fetched from Hugging Face once and read from
the local cache after that; the texts never leave the machine. Mean-pooled,
L2-normalised, with the "query: " prefix e5 models expect for symmetric use.
"""

import base64, json, sys

import numpy as np
import torch
from huggingface_hub import snapshot_download
from transformers import AutoModel, AutoTokenizer

name = sys.argv[1]
try:
    path = snapshot_download(name, local_files_only=True)
except Exception:
    print(f"downloading {name} (one time)…", file=sys.stderr)
    path = snapshot_download(name, allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt"])

device = "mps" if torch.backends.mps.is_available() else "cpu"
tok = AutoTokenizer.from_pretrained(path)
model = AutoModel.from_pretrained(path).to(device).eval()


def embed(texts):
    texts = ["query: " + t for t in texts]
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))   # similar lengths batch with less padding
    out = np.zeros((len(texts), model.config.hidden_size), dtype=np.float32)
    with torch.no_grad():
        for s in range(0, len(order), 32):
            idx = order[s:s + 32]
            enc = tok([texts[i] for i in idx], padding=True, truncation=True, max_length=512, return_tensors="pt").to(device)
            h = model(**enc).last_hidden_state
            m = enc["attention_mask"].unsqueeze(-1).to(h.dtype)
            out[idx] = torch.nn.functional.normalize((h * m).sum(1) / m.sum(1), dim=-1).float().cpu().numpy()
    return out


for line in sys.stdin:
    try:
        v = embed(json.loads(line)["texts"])
        ans = {"dim": v.shape[1], "device": device, "vectors": base64.b64encode(v.astype("<f4").tobytes()).decode()}
    except Exception as e:
        ans = {"error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(ans) + "\n")
    sys.stdout.flush()
