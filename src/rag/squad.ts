import { readFileSync } from "node:fs";
import { z } from "zod";

export interface Paragraph {
  id: string; // "<articleIndex>-<paragraphIndex>": position in the pinned file
  title: string;
  text: string;
}

export interface Question {
  id: string;
  text: string;
  answers: string[]; // every accepted gold answer; score against the best match
  paragraphId: string; // the gold paragraph this question was written about
}

export interface SquadData {
  paragraphs: Paragraph[];
  questions: Question[];
}

// The shape we rely on in the raw file. Fields we don't read (like answer_start)
// are ignored. If the file doesn't match, parse() throws instead of failing later.
const rawSquad = z.object({
  data: z.array(
    z.object({
      title: z.string(),
      paragraphs: z.array(
        z.object({
          context: z.string(),
          qas: z.array(
            z.object({
              id: z.string(),
              question: z.string(),
              answers: z.array(z.object({ text: z.string() })),
            }),
          ),
        }),
      ),
    }),
  ),
});

// Takes the path as a parameter so a test can pass a tiny fake file.
export function loadSquad(filePath: string): SquadData {
  const raw = rawSquad.parse(JSON.parse(readFileSync(filePath, "utf8")));
  const paragraphs: Paragraph[] = [];
  const questions: Question[] = [];

  raw.data.forEach((article, a) => {
    article.paragraphs.forEach((para, p) => {
      const id = `${a}-${p}`;
      paragraphs.push({ id, title: article.title, text: para.context });
      // Questions are nested inside their paragraph in the file; flattening would lose
      // that link, so we copy the paragraph id onto each question here.
      for (const qa of para.qas) {
        questions.push({
          id: qa.id,
          text: qa.question,
          answers: qa.answers.map((ans) => ans.text),
          paragraphId: id,
        });
      }
    });
  });

  return { paragraphs, questions };
}
