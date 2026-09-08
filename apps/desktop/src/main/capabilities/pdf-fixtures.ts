export function buildPdf(pageTexts: string[]): Uint8Array {
  const bodies: string[] = []
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  bodies[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`
  bodies[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  pageTexts.forEach((text, i) => {
    const pageObj = 4 + i * 2
    const contentObj = pageObj + 1
    bodies[pageObj - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
    bodies[contentObj - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  bodies.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    // xref 每项必须恰好 20 字节
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return fromLatin1(Buffer.from(pdf, 'latin1'))
}
export function buildEncryptedPdf(): Uint8Array {
  const normal = Buffer.from(buildPdf(['secret content']))
  const tampered = normal
    .toString('latin1')
    .replace(
      '/Root 1 0 R >>',
      '/Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >> >>'
    )
  return fromLatin1(Buffer.from(tampered, 'latin1'))
}

// 损坏 fixtures
export function buildCorruptPdf(): Uint8Array {
  return fromLatin1(Buffer.from('%PDF-1.4\nthis is not a valid pdf body\n', 'latin1'))
}
// 空文本页
export function buildBlankPdf(): Uint8Array {
  return buildPdf(['', '   '])
}

export function fromLatin1(buf: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}
