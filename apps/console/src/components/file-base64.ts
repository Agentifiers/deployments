export function fileBase64(file: File): Promise<string> {
  const { promise, reject, resolve } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
  reader.onload = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : "";
    resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
  };
  reader.readAsDataURL(file);
  return promise;
}
