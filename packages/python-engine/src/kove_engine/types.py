from __future__ import annotations

from enum import Enum

from pydantic import BaseModel


class SceneType(str, Enum):
    TALKING = "talking"
    ACTION = "action"
    TRANSITION = "transition"
    B_ROLL = "b-roll"
    SILENCE = "silence"
    MUSIC = "music"


class MotionLevel(str, Enum):
    STATIC = "static"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class FrameDescription(BaseModel):
    timestamp: float
    description: str
    scene_type: SceneType
    motion_level: MotionLevel
    has_dialogue: bool
    confidence: float


class VideoSegment(BaseModel):
    id: str
    start_time: float
    end_time: float
    description: str
    scene_type: SceneType
    motion_level: MotionLevel
    has_dialogue: bool
    visual_content: str
    confidence: float


class VideoSegmentMap(BaseModel):
    video_id: str
    duration: float
    segments: list[VideoSegment]


class SegmentMap(BaseModel):
    videos: list[VideoSegmentMap]


class FrameData(BaseModel):
    timestamp: float
    image_path: str
    audio_path: str | None = None
    prev_frame_path: str | None = None


class MotionResult(BaseModel):
    motion_level: MotionLevel
    raw_score: float


class AudioResult(BaseModel):
    has_dialogue: bool
    is_silence: bool
    has_music: bool
    bpm: float | None
    rms_energy: float


class FaceResult(BaseModel):
    face_count: int
    has_talking_head: bool
    face_positions: list[dict]


class VisualResult(BaseModel):
    brightness: float
    dominant_colors: list[str]
    color_histogram: list[float]
    scene_setting: str


class ClassifierResult(BaseModel):
    scene_type: SceneType
    confidence: float
    reasoning: str
