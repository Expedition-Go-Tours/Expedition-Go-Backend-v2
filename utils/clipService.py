"""
CLIP Microservice — Zero-shot image classification + embeddings for TravioAfrica.

Endpoints:
  POST /classify   — classify image into categories
  POST /embed/image — get CLIP image embedding (512 floats)
  POST /embed/text  — get CLIP text embedding (512 floats)
  POST /quality     — image quality heuristic
  GET  /health      — health check

Runs on port 5001 as a PM2 process.
"""

import io
import json
import sys
import time
import urllib.request
from functools import lru_cache

import clip
import torch
from flask import Flask, request, jsonify
from PIL import Image

app = Flask(__name__)

# ─── Model Loading ──────────────────────────────────────────────────
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL = None
PREPROCESS = None


def load_model():
    global MODEL, PREPROCESS
    if MODEL is None:
        print("[CLIP] Loading ViT-B/32 model...", flush=True)
        MODEL, PREPROCESS = clip.load("ViT-B/32", device=DEVICE)
        MODEL.eval()
        print(f"[CLIP] Model loaded on {DEVICE}", flush=True)


# ─── Category Labels ────────────────────────────────────────────────
CATEGORY_LABELS = [
    "sports and adventure activities",
    "food and drink experiences",
    "art and museum visits",
    "architecture and buildings",
    "music and shows entertainment",
    "culture and heritage sites",
    "animals and nature wildlife",
    "water activities and beaches",
    "winter and snow activities",
    "desert and safari tours",
    "nature and outdoors hiking",
    "city and walking tours",
    "seasonal and events festivals",
    "wellness and relaxation spa",
    "royalty and history castles",
    "pop culture and media",
    "mystery and horror experiences",
    "nightlife and party events",
    "transportation and travel",
]

CATEGORY_SLUGS = [
    "sports_adventure",
    "food_drink",
    "art_museums",
    "architecture",
    "music_shows",
    "culture_heritage",
    "animals_nature",
    "water_activities",
    "winter_snow",
    "desert_safari",
    "nature_outdoors",
    "city_walking",
    "seasonal_events",
    "wellness_relaxation",
    "royalty_history",
    "pop_culture",
    "mystery_horror",
    "nightlife_party",
    "transportation",
]


def load_image_from_url(url: str) -> Image.Image:
    """Download image from URL and return PIL Image."""
    req = urllib.request.Request(url, headers={"User-Agent": "TravioAfrica-CLIP/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return Image.open(io.BytesIO(resp.read())).convert("RGB")


def load_image_from_bytes(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGB")


# ─── Endpoints ──────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": "ViT-B/32", "device": DEVICE})


@app.route("/classify", methods=["POST"])
def classify():
    """
    Zero-shot classify an image into categories.
    Body: { "imageUrl": "https://...", "candidateLabels": ["optional", "override"] }
    Returns: { "label": "sports_adventure", "confidence": 0.82, "allScores": {...}, "subjects": [...] }
    """
    load_model()
    data = request.get_json(force=True)
    image_url = data.get("imageUrl")
    if not image_url:
        return jsonify({"error": "imageUrl required"}), 400

    custom_labels = data.get("candidateLabels")
    labels = custom_labels or CATEGORY_LABELS
    slugs = CATEGORY_SLUGS if not custom_labels else [l.lower().replace(" ", "_") for l in labels]

    try:
        image = load_image_from_url(image_url)
        image_input = PREPROCESS(image).unsqueeze(0).to(DEVICE)
        text_tokens = clip.tokenize(labels).to(DEVICE)

        with torch.no_grad():
            image_features = MODEL.encode_image(image_input)
            text_features = MODEL.encode_text(text_tokens)

            # Normalize
            image_features /= image_features.norm(dim=-1, keepdim=True)
            text_features /= text_features.norm(dim=-1, keepdim=True)

            # Cosine similarity
            similarity = (100.0 * image_features @ text_features.T).softmax(dim=-1)
            scores = similarity[0].cpu().tolist()

        # Build results
        all_scores = {slug: round(score, 4) for slug, score in zip(slugs, scores)}
        best_idx = scores.index(max(scores))
        confidence = scores[best_idx]

        # Detect subjects from top labels
        sorted_pairs = sorted(zip(slugs, scores), key=lambda x: -x[1])
        subjects = [slug for slug, score in sorted_pairs[:3] if score > 0.05]

        return jsonify({
            "label": slugs[best_idx],
            "confidence": round(confidence, 4),
            "allScores": all_scores,
            "subjects": subjects,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/embed/image", methods=["POST"])
def embed_image():
    """
    Get CLIP image embedding vector.
    Body: { "imageUrl": "https://..." }
    Returns: { "embedding": [0.012, -0.034, ...] }  (512 floats)
    """
    load_model()
    data = request.get_json(force=True)
    image_url = data.get("imageUrl")
    if not image_url:
        return jsonify({"error": "imageUrl required"}), 400

    try:
        image = load_image_from_url(image_url)
        image_input = PREPROCESS(image).unsqueeze(0).to(DEVICE)

        with torch.no_grad():
            features = MODEL.encode_image(image_input)
            features /= features.norm(dim=-1, keepdim=True)

        return jsonify({"embedding": features[0].cpu().tolist()})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/embed/text", methods=["POST"])
def embed_text():
    """
    Get CLIP text embedding vector.
    Body: { "text": "kakum national park canopy walk" }
    Returns: { "embedding": [0.012, -0.034, ...] }  (512 floats)
    """
    load_model()
    data = request.get_json(force=True)
    text = data.get("text")
    if not text:
        return jsonify({"error": "text required"}), 400

    try:
        text_tokens = clip.tokenize([text]).to(DEVICE)

        with torch.no_grad():
            features = MODEL.encode_text(text_tokens)
            features /= features.norm(dim=-1, keepdim=True)

        return jsonify({"embedding": features[0].cpu().tolist()})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/quality", methods=["POST"])
def quality():
    """
    Image quality heuristic based on CLIP confidence spread.
    Body: { "imageUrl": "https://..." }
    Returns: { "score": 0.72, "issues": ["low_contrast", "blurry"] }
    """
    load_model()
    data = request.get_json(force=True)
    image_url = data.get("imageUrl")
    if not image_url:
        return jsonify({"error": "imageUrl required"}), 400

    try:
        image = load_image_from_url(image_url)

        # Check basic image properties
        issues = []
        width, height = image.size
        if width < 400 or height < 300:
            issues.append("low_resolution")

        # CLIP confidence as quality proxy — high confidence = clear subject
        image_input = PREPROCESS(image).unsqueeze(0).to(DEVICE)
        text_tokens = clip.tokenize(CATEGORY_LABELS).to(DEVICE)

        with torch.no_grad():
            image_features = MODEL.encode_image(image_input)
            text_features = MODEL.encode_text(text_tokens)
            image_features /= image_features.norm(dim=-1, keepdim=True)
            text_features /= text_features.norm(dim=-1, keepdim=True)
            similarity = (100.0 * image_features @ text_features.T).softmax(dim=-1)
            scores = similarity[0].cpu().tolist()

        max_score = max(scores)
        entropy = -sum(s * (s + 1e-10).__log__() for s in scores if s > 0)

        # High entropy = unclear subject = lower quality
        # Low entropy + high max = clear subject = higher quality
        quality_score = max_score * (1 - entropy / 3.0)  # normalize
        quality_score = max(0.0, min(1.0, quality_score))

        if max_score < 0.15:
            issues.append("unclear_subject")
        if entropy > 2.5:
            issues.append("no_clear_category")

        return jsonify({
            "score": round(quality_score, 4),
            "issues": issues,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Startup ────────────────────────────────────────────────────────

if __name__ == "__main__":
    load_model()
    print("[CLIP] Starting microservice on port 5001", flush=True)
    app.run(host="127.0.0.1", port=5001, debug=False)
