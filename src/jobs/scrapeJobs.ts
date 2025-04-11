import JobListing from "../models/JobListing";
import {
  scrapeWeWorkRemotely,
  scrapeRemotive,
  scrapeRemoteOK,
  scrapeJSRemotely,
  scrapeReactJobsBoard,
  scrapeNoDesk,
} from "./scrapers";

// Sources to scrape jobs from
const sources = [
  {
    name: "WeWorkRemotely",
    url: "https://weworkremotely.com/categories/remote-programming-jobs",
    scraper: scrapeWeWorkRemotely,
  },
  // {
  //   name: "Remotive",
  //   url: "https://remotive.io/remote-jobs/software-dev",
  //   scraper: scrapeRemotive,
  // },
  // {
  //   name: "RemoteOK",
  //   url: "https://remoteok.com/remote-dev-jobs",
  //   scraper: scrapeRemoteOK,
  // },
  // {
  //   name: "JSRemotely",
  //   url: "https://jsremotely.com/remote-javascript-jobs",
  //   scraper: scrapeJSRemotely,
  // },
  // {
  //   name: "ReactJobsBoard",
  //   url: "https://reactjobsboard.com/remote-react-jobs",
  //   scraper: scrapeReactJobsBoard,
  // },
  // {
  //   name: "NoDesk",
  //   url: "https://nodesk.co/remote-jobs/",
  //   scraper: scrapeNoDesk,
  // },
];

export async function runDailyJobScraping(): Promise<void> {
  console.log("Starting daily job scraping task...");

  try {
    const existingJobs = await JobListing.find({}, { url: 1 });
    const existingURLs = new Set(
      existingJobs.map((j) => j.url.trim().toLowerCase())
    );

    for (const source of sources) {
      console.log(`Scraping jobs from ${source.name}...`);
      const jobs = await source.scraper();

      for (const job of jobs) {
        job.source = source.name;
        job.scrapedDate = new Date();

        const normalizedUrl = job.url.trim().toLowerCase();

        if (!existingURLs.has(normalizedUrl)) {
          await JobListing.create(job);
          existingURLs.add(normalizedUrl); // Add to set to catch dups in same batch
          console.log(`Saved new job: ${job.title} at ${job.company}`);
        } else {
          console.log(`Job already exists: ${job.title} at ${job.company}`);
        }
      }
    }

    console.log("Job scraping completed successfully");
  } catch (error) {
    console.error("Error during job scraping:", error);
  }
}

// This function will be called by a scheduler
export default runDailyJobScraping;
