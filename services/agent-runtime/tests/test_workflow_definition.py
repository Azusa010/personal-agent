"""工作流数据模型与状态推导机制测试。"""

from personal_agent.workflow.definition import (
    WorkflowDefinition,
    WorkflowState,
    WorkflowStep,
)


def test_workflow_state_recording_and_parameter_resolution():
    state = WorkflowState(inputs={"rootId": "downloads"})

    # 模拟步骤 1：列出文件
    step1 = WorkflowStep(
        id="list_files",
        capability="filesystem.list",
        description="列出文件",
        resolve_args=lambda s: {"rootId": s.inputs["rootId"]},
    )
    args1 = step1.resolve_args(state)
    assert args1 == {"rootId": "downloads"}

    # 模拟步骤 1 执行完毕落库
    state.set_result(
        "list_files",
        {"entries": [{"name": "sample.pdf", "path": "/downloads/sample.pdf"}]},
    )

    # 模拟步骤 2：依赖步骤 1 产出的路径
    step2 = WorkflowStep(
        id="extract_text",
        capability="document.extract_pdf",
        description="提取 PDF 内容",
        resolve_args=lambda s: {
            "path": s.get_result("list_files")["entries"][0]["path"]
        },
    )
    args2 = step2.resolve_args(state)
    assert args2 == {"path": "/downloads/sample.pdf"}


def test_workflow_definition_assembly():
    wf = WorkflowDefinition(
        id="test_wf",
        name="测试工作流",
        steps=[
            WorkflowStep(
                id="step1",
                capability="filesystem.list",
                description="步骤1",
                resolve_args=lambda s: {},
            )
        ],
    )
    assert len(wf.steps) == 1
    assert wf.steps[0].id == "step1"