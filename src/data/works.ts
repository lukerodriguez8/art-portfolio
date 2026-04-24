export interface Work {
  id: string;
  title: string;
  year: number;
  medium?: string;
  filename: string; // relative to /works/
  width: number;
  height: number;
}

export const works: Work[] = [
  // Add your artwork here. Example:
  // {
  //   id: "untitled-01",
  //   title: "Untitled 01",
  //   year: 2024,
  //   medium: "Digital",
  //   filename: "untitled-01.png",
  //   width: 1200,
  //   height: 1600,
  // },
];
