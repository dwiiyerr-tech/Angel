from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict
import sys
import os

# Add the pipeline directory to path so we can import the model logic
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import predict_momentum

app = FastAPI()

# Pre-load the model
predict_momentum.load_model()

class PredictRequest(BaseModel):
    candidate: Dict[str, Any]

@app.get("/health")
def health_check():
    loaded = predict_momentum._model is not None
    return {"status": "ok", "model_loaded": loaded}

@app.post("/predict")
def predict(req: PredictRequest):
    try:
        result = predict_momentum.predict(req.candidate)
        if result.get("error"):
            raise HTTPException(status_code=500, detail=result["error"])
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
