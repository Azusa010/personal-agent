from typing import Any, Literal, Self

from pydantic import BaseModel, Field, model_validator

METHOD_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"


class JsonRpcError(BaseModel):
    code: str
    message: str
    data: Any | None = None


class Request(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    method: str = Field(pattern=METHOD_PATTERN)
    params: Any = None


class Response(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str = Field(min_length=1)
    result: Any | None = None
    error: JsonRpcError | None = None

    @model_validator(mode="after")
    def check_exactly_one(self) -> Self:
        if (self.result is None) == (self.error is None):
            raise ValueError("result and error must not be present at the same time")
        return self


class Notification(BaseModel):
    jsonrpc: Literal["2.0"]
    method: str = Field(pattern=METHOD_PATTERN)
    params: Any = None


# ---- PDF ----
class PdfEntry(BaseModel):
    name: str
    absolutePath: str
    modifiedAt: str
    sizeBytes: int = Field(ge=0)


class FilesystemListParams(BaseModel):
    rootId: Literal["downloads"]

class FilesystemListResult(BaseModel):
    entries: list[PdfEntry]


# ---- system.initialize 的载荷模型 ----
class ClientInfo(BaseModel):
    name: str
    version: str


class ServerInfo(BaseModel):
    name: str
    version: str


class InitializeParams(BaseModel):
    protocolVersion: Literal["0.1"]  # 字段名直接用 JSON 里的 key，保持两端一致
    client: ClientInfo


class InitializeResult(BaseModel):
    protocolVersion: Literal["0.1"]
    server: ServerInfo
