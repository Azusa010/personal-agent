from typing import Any

from pydantic import BaseModel, Literal, Optional, model_validator


class Request(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str
    method: str
    params: Any


class errors(BaseModel):
    code: int
    message: str
    data: Optional[Any]


class Response(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str
    result: Optional[any]
    error: Optional[errors]

    @model_validator(mode="after")
    def validate_message(self) -> self:
        if self.result is not None and self.error is not None:
            raise ValueError("result and error must not be present at the same time")
        return self


class Notification(BaseModel):
    jsonrpc: Literal["2.0"]
    method: str
    params: Any
