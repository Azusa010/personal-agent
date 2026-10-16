from pydantic import BaseModel, ConfigDict


class DreamRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    force:bool = False
    min_pending_items:int = 5

class DreamResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    success:bool = True
    consolidated_items_count:int
    categories_updated:list[str]
    index_rebuilt:bool
    message:str
    lock_file_path:str | None = None
