
from pydantic import BaseModel, ConfigDict


class TopicSwitchRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    old_topic_summary: str
    new_topic_intent: str
    switch_user_seq_id: int | None = None

class TopicSwitchResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    success: bool
    archived_epoch_id: int
    archived_file_path: str
    new_topic_intent: str
    message: str
