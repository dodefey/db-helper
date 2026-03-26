import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function promptText(message: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(`${message}: `)).trim();
  } finally {
    rl.close();
  }
}

export async function promptConfirm(message: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const value = (await promptText(`${message} ${suffix}`)).toLowerCase();
  if (!value) {
    return defaultYes;
  }

  return value === "y" || value === "yes";
}

export async function promptChoice<T>(message: string, choices: Array<{ label: string; value: T }>): Promise<T> {
  process.stdout.write(`${message}\n`);
  choices.forEach((choice, index) => {
    process.stdout.write(`  ${index + 1}. ${choice.label}\n`);
  });

  while (true) {
    const answer = await promptText("Select a number");
    const selected = Number(answer);
    if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) {
      return choices[selected - 1].value;
    }

    process.stdout.write("Invalid selection.\n");
  }
}
