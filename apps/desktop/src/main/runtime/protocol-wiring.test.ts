import { describe,it,expect } from "vitest";

import {PROTOCOL_VERSION,ERROR_CODE} from '@personal-agent/protocol'

describe('protocol 包接线 (app/desktop -> @personal-agent/protocol',()=>{
  it('能解析barrel 并导入协议常量',()=>{
    expect(PROTOCOL_VERSION).toBe('0.1')
    expect(ERROR_CODE.METHOD_NOT_FOUND).toBe('METHOD_NOT_FOUND')
  })
})
